// Watches what the run is actually doing to the phone while it happens: frame
// pacing (the thing you feel), battery drain, heap growth, and achieved speed.
// The samples are shown live and then folded back into the calibration, so the
// next estimate is closer.

export class RunMonitor {
  constructor() {
    this.reset();
  }

  reset() {
    this.frames = [];
    this.jankFrames = 0;
    this.totalFrames = 0;
    this.samples = [];
    this.startedAt = null;
    this.battery = { start: null, end: null, supported: false };
    this.running = false;
    this._raf = null;
    this._timer = null;
    this._lastFrame = 0;
  }

  async start(onSample = () => {}) {
    this.reset();
    this.running = true;
    this.startedAt = performance.now();
    this.onSample = onSample;

    try {
      const b = await navigator.getBattery?.();
      if (b) { this._bat = b; this.battery = { start: b.level, end: b.level, supported: true, charging: b.charging }; }
    } catch { /* unsupported */ }

    // A frame that takes longer than two 60 Hz refreshes is a frame you notice.
    const tick = (t) => {
      if (!this.running) return;
      if (this._lastFrame) {
        const dt = t - this._lastFrame;
        this.totalFrames++;
        if (dt > 32) this.jankFrames++;
        if (this.frames.length < 6000) this.frames.push(dt);
      }
      this._lastFrame = t;
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);

    this._timer = setInterval(() => this._sample(), 2000);
    this._sample();
  }

  _sample() {
    if (!this.running) return;
    const s = {
      t: (performance.now() - this.startedAt) / 1000,
      jankPct: this.totalFrames ? this.jankFrames / this.totalFrames : 0,
      fps: this.frames.length ? 1000 / (this.frames.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, this.frames.length)) : null,
      heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
      batteryLevel: this._bat ? this._bat.level : null,
      charging: this._bat ? this._bat.charging : null,
    };
    if (this._bat) this.battery.end = this._bat.level;
    this.samples.push(s);
    this.onSample(s);
  }

  /** Recent frame-pacing, i.e. how janky the device feels right now. */
  recentJank(windowFrames = 120) {
    const w = this.frames.slice(-windowFrames);
    if (!w.length) return 0;
    return w.filter((d) => d > 32).length / w.length;
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._timer) clearInterval(this._timer);
    this._sample?.();
    const elapsed = (performance.now() - this.startedAt) / 1000;
    const drain = this.battery.supported && this.battery.start != null && this.battery.end != null
      ? this.battery.start - this.battery.end : null;
    return {
      elapsedSec: elapsed,
      jankPct: this.totalFrames ? this.jankFrames / this.totalFrames : null,
      medianFrameMs: median(this.frames),
      p95FrameMs: percentile(this.frames, 0.95),
      batteryDrop: drain,
      batteryPctPerHour: drain != null && elapsed > 60 ? (drain * 100) / (elapsed / 3600) : null,
      peakHeapMB: Math.max(0, ...this.samples.map((s) => s.heapMB || 0)) || null,
      samples: this.samples,
    };
  }
}

function median(a) { return percentile(a, 0.5); }
function percentile(a, p) {
  if (!a?.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

/** Keeps the screen on for the duration of an on-device run, and re-takes the lock after a tab switch. */
export class ScreenLock {
  constructor() { this.sentinel = null; this.active = false; this._onVis = null; }
  get supported() { return "wakeLock" in navigator; }
  async acquire() {
    if (!this.supported) return false;
    try {
      this.sentinel = await navigator.wakeLock.request("screen");
      this.active = true;
      this.sentinel.addEventListener("release", () => { this.active = false; });
      this._onVis = async () => {
        if (document.visibilityState === "visible" && !this.active) { try { await this.acquire(); } catch { /* ignore */ } }
      };
      document.addEventListener("visibilitychange", this._onVis);
      return true;
    } catch { return false; }
  }
  async release() {
    if (this._onVis) document.removeEventListener("visibilitychange", this._onVis);
    try { await this.sentinel?.release(); } catch { /* ignore */ }
    this.sentinel = null; this.active = false;
  }
}
