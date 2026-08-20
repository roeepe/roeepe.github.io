// Runs the ivrit-ai Whisper ONNX model off the main thread. Everything that can
// stall — weight download, session creation, generation — happens here, so the
// UI stays responsive enough to show progress and to let you cancel.

const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.web.min.js";

let tf = null;          // the transformers.js module
let asr = null;         // the loaded pipeline
let loadedKey = null;   // repo|dtype|device of whatever is currently loaded
let cancelled = false;

const post = (msg, transfer = []) => self.postMessage(msg, transfer);

async function ensureTransformers() {
  if (!tf) {
    tf = await import(TRANSFORMERS_URL);
    tf.env.allowLocalModels = false;
    tf.env.useBrowserCache = true;
    if (tf.env.backends?.onnx?.wasm) {
      tf.env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
      tf.env.backends.onnx.wasm.proxy = false;
    }
  }
  return tf;
}

async function init({ repoId, dtype, device, revision = "main" }) {
  await ensureTransformers();
  const key = `${repoId}|${dtype}|${device}|${revision}`;
  if (asr && loadedKey === key) { post({ type: "ready", key, reused: true }); return; }
  if (asr) { try { await asr.dispose?.(); } catch { /* ignore */ } asr = null; loadedKey = null; }

  const t0 = performance.now();
  const seen = new Map();
  try {
    asr = await tf.pipeline("automatic-speech-recognition", repoId, {
      revision,
      device,                                   // "webgpu" | "wasm"
      dtype: { encoder_model: dtype, decoder_model_merged: dtype },
      progress_callback: (p) => {
        if (p.status === "progress" && p.file) {
          seen.set(p.file, { loaded: p.loaded, total: p.total });
          let loaded = 0, total = 0;
          for (const v of seen.values()) { loaded += v.loaded || 0; total += v.total || 0; }
          post({ type: "load-progress", file: p.file, loaded, total, ratio: total ? loaded / total : 0 });
        } else if (p.status === "done" || p.status === "ready") {
          post({ type: "load-stage", stage: p.status, file: p.file || null });
        }
      },
    });
    loadedKey = key;
    post({ type: "ready", key, loadMs: performance.now() - t0, reused: false });
  } catch (e) {
    post({ type: "error", phase: "init", message: String(e?.message || e), stack: String(e?.stack || "") });
  }
}

async function transcribe({ pcm, offset = 0, trimStart = 0, language = "he", returnTimestamps = true, chunkLengthS = 30, strideLengthS = 5, index = 0 }) {
  if (!asr) { post({ type: "error", phase: "transcribe", message: "המודל לא נטען" }); return; }
  cancelled = false;
  const audio = pcm instanceof Float32Array ? pcm : new Float32Array(pcm);
  const t0 = performance.now();
  try {
    const out = await asr(audio, {
      language, task: "transcribe",
      return_timestamps: returnTimestamps,
      chunk_length_s: chunkLengthS,
      stride_length_s: strideLengthS,
      // A per-chunk hook is the only place a long generation can be interrupted.
      callback_function: () => { if (cancelled) throw new Error("CANCELLED"); },
    });

    const chunks = (out.chunks || [])
      .map((c) => ({
        start: (c.timestamp?.[0] ?? 0) + offset,
        end: (c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0) + offset,
        text: (c.text || "").trim(),
      }))
      // Drop what the previous segment already covered. Judged by the middle of
      // the chunk, so a sentence straddling the seam lands in exactly one
      // segment instead of being dropped by both.
      .filter((c) => c.text && (c.start + c.end) / 2 >= offset + trimStart);

    post({
      type: "segment-done", index,
      text: chunks.length ? chunks.map((c) => c.text).join(" ") : (out.text || "").trim(),
      chunks,
      audioSeconds: audio.length / 16000,
      inferMs: performance.now() - t0,
    });
  } catch (e) {
    const msg = String(e?.message || e);
    post({ type: msg === "CANCELLED" ? "cancelled" : "error", phase: "transcribe", index, message: msg, stack: String(e?.stack || "") });
  }
}

self.onmessage = async (ev) => {
  const m = ev.data;
  switch (m.type) {
    case "init": return init(m);
    case "transcribe": return transcribe(m);
    case "cancel": cancelled = true; return;
    case "dispose":
      try { await asr?.dispose?.(); } catch { /* ignore */ }
      asr = null; loadedKey = null;
      post({ type: "disposed" });
      return;
  }
};
