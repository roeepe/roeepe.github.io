// Drives an on-device transcription end to end: load the model, walk the
// recording segment by segment, keep partial results safe, and hand the
// measured numbers back for calibration.

import { openAudioSource, planSegments } from "./audio.js";
import { RunMonitor, ScreenLock } from "./monitor.js";
import { store } from "./util.js";

const RESUME_KEY = "resume.local";

export class LocalRun extends EventTarget {
  constructor() {
    super();
    this.worker = null;
    this.monitor = new RunMonitor();
    this.lock = new ScreenLock();
    this.cancelled = false;
    this.results = [];
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  _spawn() {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    return this.worker;
  }

  _once(match, { timeoutMs = 0 } = {}) {
    return new Promise((resolve, reject) => {
      const t = timeoutMs ? setTimeout(() => { cleanup(); reject(new Error("timeout")); }, timeoutMs) : null;
      const onMsg = (ev) => {
        const m = ev.data;
        if (m.type === "error") { cleanup(); reject(Object.assign(new Error(m.message), { phase: m.phase, stack: m.stack })); return; }
        if (match(m)) { cleanup(); resolve(m); return; }
        this.emit("progress", m);
      };
      const cleanup = () => { if (t) clearTimeout(t); this.worker.removeEventListener("message", onMsg); };
      this.worker.addEventListener("message", onMsg);
    });
  }

  async loadModel({ repoId, dtype, device, revision = "main" }) {
    this._spawn();
    const p = this._once((m) => m.type === "ready");
    this.worker.postMessage({ type: "init", repoId, dtype, device, revision });
    return p;
  }

  /**
   * @param {File} file
   * @param {object} info result of probeAudio()
   * @param {object} opts {repoId, dtype, device, language, segmentSec, keepScreenOn, resume}
   */
  async run(file, info, opts) {
    this.cancelled = false;
    this.results = [];
    const t0 = performance.now();
    const timing = { load: 0, decode: 0, infer: 0 };

    if (opts.keepScreenOn !== false) {
      const got = await this.lock.acquire();
      this.emit("wakelock", { acquired: got, supported: this.lock.supported });
    }
    await this.monitor.start((s) => this.emit("telemetry", s));

    try {
      this.emit("phase", { id: "load", label: "טוען את המודל" });
      const tLoad = performance.now();
      const ready = await this.loadModel(opts);
      timing.load = (performance.now() - tLoad) / 1000;
      this.emit("phase-done", { id: "load", seconds: timing.load, reused: ready.reused });

      this.emit("phase", { id: "decode", label: "מכין את האודיו" });
      const tDec = performance.now();
      const source = await openAudioSource(file, info, (p) => this.emit("progress", { type: "decode", ...p }));
      timing.decode = (performance.now() - tDec) / 1000;
      this.emit("phase-done", { id: "decode", seconds: timing.decode, kind: source.kind, peakBytes: source.peakBytes });

      const segments = planSegments(source.seconds, { segmentSec: opts.segmentSec ?? 600, overlapSec: 3 });
      const resume = opts.resume ? store.get(RESUME_KEY) : null;
      const resumable = resume && resume.fileName === file.name && resume.fileSize === file.size && resume.repoId === opts.repoId;
      if (resumable) {
        this.results = resume.results || [];
        this.emit("resumed", { done: this.results.length, of: segments.length });
      }

      this.emit("phase", { id: "infer", label: "מתמלל", segments: segments.length });
      const tInf = performance.now();
      let audioDone = 0;

      for (const seg of segments) {
        if (this.cancelled) break;
        // Progress tracks the position reached, not the sum of segment lengths:
        // segments overlap, and summing them would push past 100%.
        if (this.results.some((r) => r.index === seg.index)) { audioDone = seg.end; continue; }

        const pcm = await source.getSegment(seg.start, seg.end);
        const done = this._once((m) => m.type === "segment-done" || m.type === "cancelled");
        this.worker.postMessage({
          type: "transcribe", pcm, offset: seg.start, trimStart: seg.trimStart,
          language: opts.language || "he", returnTimestamps: true, index: seg.index,
        }, [pcm.buffer]);

        const res = await done;
        if (res.type === "cancelled") break;

        this.results.push({ index: seg.index, text: res.text, chunks: res.chunks, inferMs: res.inferMs, audioSeconds: res.audioSeconds });
        this.results.sort((a, b) => a.index - b.index);
        audioDone = seg.end;

        store.set(RESUME_KEY, {
          fileName: file.name, fileSize: file.size, repoId: opts.repoId,
          at: Date.now(), results: this.results,
        });

        const elapsed = (performance.now() - tInf) / 1000;
        this.emit("segment", {
          index: seg.index, of: segments.length,
          audioDone, audioTotal: source.seconds,
          ratio: audioDone / source.seconds,
          observedRtf: audioDone / Math.max(0.001, elapsed),
          etaSec: (source.seconds - audioDone) / Math.max(0.01, audioDone / Math.max(0.001, elapsed)),
          jankPct: this.monitor.recentJank(),
          text: res.text,
        });
      }

      timing.infer = (performance.now() - tInf) / 1000;
      const telemetry = this.monitor.stop();
      await this.lock.release();

      const ok = !this.cancelled && this.results.length === segments.length;
      if (ok) store.del(RESUME_KEY);

      return {
        ok, cancelled: this.cancelled,
        chunks: this.results.flatMap((r) => r.chunks || []).sort((a, b) => a.start - b.start),
        text: this.results.map((r) => r.text).join(" ").replace(/\s+/g, " ").trim(),
        timing, totalSeconds: (performance.now() - t0) / 1000,
        audioSeconds: source.seconds, telemetry, backend: opts.device,
      };
    } catch (e) {
      const telemetry = this.monitor.stop();
      await this.lock.release();
      return {
        ok: false, error: String(e?.message || e), phase: e?.phase || null,
        chunks: this.results.flatMap((r) => r.chunks || []),
        text: this.results.map((r) => r.text).join(" ").trim(),
        timing, totalSeconds: (performance.now() - t0) / 1000, telemetry, backend: opts.device,
      };
    }
  }

  cancel() {
    this.cancelled = true;
    this.worker?.postMessage({ type: "cancel" });
  }

  dispose() {
    try { this.worker?.terminate(); } catch { /* ignore */ }
    this.worker = null;
  }

  static pendingResume() { return store.get(RESUME_KEY); }
  static clearResume() { store.del(RESUME_KEY); }
}
