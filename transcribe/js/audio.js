// Audio handling with one rule: never hold more of the recording in memory than
// the phone can afford. Duration and size are read without decoding at all, so
// the estimator can answer "how long will this take" for a two-hour file that
// the device could never decode in one piece.

const TARGET_RATE = 16000;   // what Whisper's feature extractor expects

/** Duration + format facts, without decoding a single sample. */
export async function probeAudio(file) {
  const info = {
    name: file.name, bytes: file.size, type: file.type || guessType(file.name),
    seconds: null, sampleRate: null, channels: null,
    container: (file.name.split(".").pop() || "").toLowerCase(),
    sliceable: false, decodeInMemory: true, error: null,
  };

  const wav = await readWavHeader(file);
  if (wav) {
    Object.assign(info, {
      seconds: wav.seconds, sampleRate: wav.sampleRate, channels: wav.channels,
      sliceable: true, decodeInMemory: false, wav,
    });
    return info;
  }

  try {
    info.seconds = await durationViaElement(file);
  } catch (e) {
    info.error = String(e?.message || e);
  }
  // Compressed formats have to go through decodeAudioData in one piece, which
  // briefly materialises the whole recording as float32 at its native rate.
  info.decodeInMemory = true;
  info.sampleRate = info.sampleRate || 44100;
  info.channels = info.channels || 1;
  return info;
}

function guessType(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return { mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
           ogg: "audio/ogg", opus: "audio/ogg", webm: "audio/webm", flac: "audio/flac" }[ext] || "";
}

function durationViaElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el = new Audio();
    const done = (fn) => (v) => { URL.revokeObjectURL(url); el.src = ""; fn(v); };
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      if (el.duration === Infinity) {
        // Some WebM/Opus recordings report Infinity until you seek to the end.
        el.currentTime = 1e101;
        el.ontimeupdate = () => { el.ontimeupdate = null; done(resolve)(el.duration); };
      } else done(resolve)(el.duration);
    };
    el.onerror = () => done(reject)(new Error("הדפדפן לא הצליח לקרוא את הקובץ"));
    el.src = url;
  });
}

// ── WAV: sliceable without decoding ─────────────────────────────────────────

async function readWavHeader(file) {
  if (file.size < 44) return null;
  const head = new DataView(await file.slice(0, 4096).arrayBuffer());
  const tag = (o) => String.fromCharCode(head.getUint8(o), head.getUint8(o + 1), head.getUint8(o + 2), head.getUint8(o + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;

  let off = 12, fmt = null, dataOff = null, dataLen = null;
  while (off + 8 <= head.byteLength) {
    const id = tag(off), size = head.getUint32(off + 4, true);
    if (id === "fmt ") {
      fmt = {
        format: head.getUint16(off + 8, true),
        channels: head.getUint16(off + 10, true),
        sampleRate: head.getUint32(off + 12, true),
        bits: head.getUint16(off + 22, true),
      };
    } else if (id === "data") { dataOff = off + 8; dataLen = size; break; }
    off += 8 + size + (size % 2);
  }
  if (!fmt || dataOff == null) return null;
  if (![1, 3].includes(fmt.format)) return null;            // PCM or IEEE float only
  if (![8, 16, 24, 32].includes(fmt.bits)) return null;

  const bytesPerFrame = (fmt.bits / 8) * fmt.channels;
  const total = Math.min(dataLen, file.size - dataOff);
  return { ...fmt, dataOff, dataLen: total, bytesPerFrame,
           frames: Math.floor(total / bytesPerFrame),
           seconds: Math.floor(total / bytesPerFrame) / fmt.sampleRate };
}

function wavBytesToFloat(buf, wav) {
  const dv = new DataView(buf);
  const frames = Math.floor(buf.byteLength / wav.bytesPerFrame);
  const out = new Float32Array(frames);
  const ch = wav.channels, bits = wav.bits, step = bits / 8;
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < ch; c++) {
      const o = i * wav.bytesPerFrame + c * step;
      if (bits === 16) acc += dv.getInt16(o, true) / 32768;
      else if (bits === 8) acc += (dv.getUint8(o) - 128) / 128;
      else if (bits === 32) acc += wav.format === 3 ? dv.getFloat32(o, true) : dv.getInt32(o, true) / 2147483648;
      else if (bits === 24) {
        const v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16);
        acc += v / 8388608;
      }
    }
    out[i] = acc / ch;
  }
  return out;
}

// ── resampling ──────────────────────────────────────────────────────────────

/** Proper (browser-implemented, anti-aliased) resample to 16 kHz mono. */
export async function resampleTo16k(float32, srcRate) {
  if (srcRate === TARGET_RATE) return float32;
  const frames = Math.max(1, Math.round(float32.length * TARGET_RATE / srcRate));
  const ctx = new OfflineAudioContext(1, frames, TARGET_RATE);
  const buf = ctx.createBuffer(1, float32.length, srcRate);
  buf.copyToChannel(float32, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf; src.connect(ctx.destination); src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}

// ── the source object the engine reads from ─────────────────────────────────

/**
 * Opens a recording as a segment-addressable source.
 *
 *   wav  → segments are sliced straight off disk; memory stays flat regardless
 *          of how long the recording is
 *   else → one decodeAudioData pass (the memory spike the estimator warns
 *          about), then kept as int16 @ 16 kHz, which is 5.5 MB per hour
 */
export async function openAudioSource(file, info, onProgress = () => {}) {
  if (info.sliceable && info.wav) {
    const wav = info.wav;
    return {
      kind: "wav", seconds: info.seconds, peakBytes: 0,
      async getSegment(startSec, endSec) {
        const s = Math.floor(startSec * wav.sampleRate) * wav.bytesPerFrame;
        const e = Math.min(wav.dataLen, Math.ceil(endSec * wav.sampleRate) * wav.bytesPerFrame);
        const buf = await file.slice(wav.dataOff + s, wav.dataOff + e).arrayBuffer();
        return resampleTo16k(wavBytesToFloat(buf, wav), wav.sampleRate);
      },
      release() {},
    };
  }

  onProgress({ stage: "decode", ratio: 0.05, label: "מפענח את הקובץ" });
  const ctx = new (self.AudioContext || self.webkitAudioContext)();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  } finally {
    ctx.close?.();
  }
  onProgress({ stage: "decode", ratio: 0.5, label: "ממיר ל-16 קילוהרץ" });

  // Downmix to mono in place before resampling, so the peak is one channel.
  const chans = decoded.numberOfChannels;
  const mono = new Float32Array(decoded.length);
  for (let c = 0; c < chans; c++) {
    const d = decoded.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / chans;
  }
  const srcRate = decoded.sampleRate;
  const peakBytes = decoded.length * chans * 4;
  decoded = null;

  const f32 = await resampleTo16k(mono, srcRate);
  // int16 halves the resident cost; segments are widened back on demand.
  const pcm = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, f32[i] * 32768));
  onProgress({ stage: "decode", ratio: 1, label: "מוכן" });

  return {
    kind: "pcm16", seconds: pcm.length / TARGET_RATE, peakBytes, pcm,
    async getSegment(startSec, endSec) {
      const s = Math.max(0, Math.floor(startSec * TARGET_RATE));
      const e = Math.min(pcm.length, Math.ceil(endSec * TARGET_RATE));
      const out = new Float32Array(e - s);
      for (let i = 0; i < out.length; i++) out[i] = pcm[s + i] / 32768;
      return out;
    },
    release() { /* the caller drops the reference */ },
  };
}

/**
 * Splits a recording into segments the engine transcribes one at a time, so a
 * crash costs one segment rather than the whole job. `overlapSec` is trimmed
 * back out when the text is stitched together.
 */
export function planSegments(seconds, { segmentSec = 600, overlapSec = 3 } = {}) {
  const segs = [];
  for (let t = 0; t < seconds; t += segmentSec) {
    const start = t === 0 ? 0 : t - overlapSec;
    segs.push({ index: segs.length, start, end: Math.min(seconds, t + segmentSec), trimStart: t === 0 ? 0 : overlapSec });
  }
  return segs;
}

export { TARGET_RATE };
