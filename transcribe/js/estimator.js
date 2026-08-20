// ── The resource estimator ───────────────────────────────────────────────────
//
// Answers three questions for every route, before anything is run:
//   1. כמה זמן זה ייקח   — a p50 and a p90 wall-clock estimate, broken into phases
//   2. מה הסיכוי להיכשל  — itemised hazards, each with a mitigation
//   3. כמה זה יאט אותי   — CPU/GPU pressure, UI jank, heat and battery drain
//
// Everything is derived from three inputs: measured hardware throughput
// (bench.js), browser-reported device facts (device.js), and the real byte
// count of the model files (models.js). PRIORS below are the only hand-set
// numbers, and every one of them is replaced by a measurement from this phone
// as soon as a single real run has completed (calibration.js).

import { clamp, logistic, combine } from "./util.js";
import { memoryBudgetBytes } from "./device.js";

export const PRIORS = {
  // Reference device that the throughput ratios are anchored to: a mid-range
  // 2023 Android phone. rtf = "realtime factor" = audio seconds per wall second.
  ref: {
    gpuGflops: 250,   // WebGPU FMA throughput measured by bench.js on that class of phone
    cpuGflops: 2.0,   // scalar-JS matmul on the same phone
    rtfWebGPU: 1.05,  // whisper-large-v3-turbo, q4 weights, 30 s chunks
    rtfWasm: 0.09,    // same model through the WASM backend — ~11× slower than realtime
  },
  // Throughput scales sub-linearly with raw FLOPs: whisper on a phone is
  // largely memory-bandwidth bound, and bandwidth does not grow as fast as ALUs.
  scaleExponent: 0.75,

  thermal: {
    onsetSec: 150,      // sustained load before the SoC starts pulling clocks back
    tauSec: 260,        // time constant of the decay
    floorMobile: 0.55,  // steady-state fraction of peak throughput
    floorDesktop: 0.85,
  },

  local: {
    sessionInitSec: 12,       // ONNX Runtime session creation at reference CPU speed
    decodeRtf: 45,            // native decodeAudioData: ~45× realtime at reference CPU
    resampleRtf: 300,
    downloadEfficiency: 0.7,  // share of the advertised downlink actually reached
    sustainedWatts: 3.6,      // phone SoC under continuous WebGPU compute
  },
  colab: {
    allocSec: 50,             // waiting for a GPU VM to be handed over
    warmAllocSec: 8,
    setupSec: 105,            // uv/pip install + pulling the ct2 weights onto the VM
    warmSetupSec: 6,
    rtf: { T4: 11, L4: 19, G4: 22, A100: 30, H100: 42, CPU: 1.1 },
    pNoGpuFree: 0.22,         // free tier refusing a GPU at busy hours
    pNoGpuPaid: 0.03,
    pDisconnect90min: 0.12,   // idle/So-long disconnect over a long job
  },
  actions: {
    queueSec: 25,             // runner pickup
    setupSec: 130,            // checkout + uv install + ct2 weights
    rtf: 1.15,                // faster-whisper turbo, int8, 4 vCPU ubuntu-latest
    jobLimitSec: 6 * 3600,    // hard GitHub Actions job timeout
    deliverSec: 20,
  },
  battery: { phoneWh: 15.4, uploadWatts: 1.3, idleWatts: 0.6 },
};

const GB = 1024 ** 3;

// ── throughput ──────────────────────────────────────────────────────────────

/** Realtime factor for the on-device route, from the measured benchmark. */
export function localRtf(device, bench, calib) {
  const measured = calib?.routes?.local?.rtf;
  if (measured?.value > 0 && measured.n >= 1) {
    return { rtf: measured.value, source: "measured", n: measured.n, backend: calib.routes.local.backend || "webgpu" };
  }
  if (device.gpu.webgpu && bench.gpuGflops > 0) {
    const ratio = bench.gpuGflops / PRIORS.ref.gpuGflops;
    return {
      rtf: PRIORS.ref.rtfWebGPU * Math.pow(ratio, PRIORS.scaleExponent),
      source: "bench", backend: "webgpu", ratio,
    };
  }
  const ratio = (bench.cpuGflops || PRIORS.ref.cpuGflops) / PRIORS.ref.cpuGflops;
  const threads = clamp((device.cores || 4) / 4, 0.5, 2.2);
  return {
    rtf: PRIORS.ref.rtfWasm * Math.pow(ratio, PRIORS.scaleExponent) * threads,
    source: "bench", backend: "wasm", ratio,
  };
}

/**
 * Wall seconds to push `audioSec` through a pipeline running at `rtf`, with the
 * SoC throttling as it heats up. Integrated in 15 s steps of audio.
 */
export function withThermalThrottle(audioSec, rtf, { mobile = true } = {}) {
  const { onsetSec, tauSec, floorMobile, floorDesktop } = PRIORS.thermal;
  const floor = mobile ? floorMobile : floorDesktop;
  let wall = 0, done = 0;
  const step = 15;
  while (done < audioSec) {
    const chunk = Math.min(step, audioSec - done);
    const hot = Math.max(0, wall - onsetSec);
    const factor = floor + (1 - floor) * Math.exp(-hot / tauSec);
    wall += chunk / (rtf * factor);
    done += chunk;
  }
  const endFactor = floor + (1 - floor) * Math.exp(-Math.max(0, wall - onsetSec) / tauSec);
  return { seconds: wall, finalThrottle: endFactor, lost: wall - audioSec / rtf };
}

const bytesPerSec = (mbps, eff = 1) => ((mbps || 4) * 1e6 / 8) * eff;

// ── the three routes ────────────────────────────────────────────────────────

function estimateLocal(ctx) {
  const { audio, device, bench, model, calib } = ctx;
  const t = localRtf(device, bench, calib);
  const cpuRatio = (bench.cpuGflops || PRIORS.ref.cpuGflops) / PRIORS.ref.cpuGflops;
  const phases = [];

  if (!model.cached && model.bytes) {
    const dl = bytesPerSec(device.network.downlinkMbps, PRIORS.local.downloadEfficiency);
    phases.push({ id: "download", label: `הורדת המודל (${model.dtypeLabel})`, seconds: model.bytes / dl, once: true });
  }
  phases.push({ id: "load", label: "טעינת המודל לזיכרון", seconds: PRIORS.local.sessionInitSec / Math.max(0.35, cpuRatio) });
  phases.push({ id: "decode", label: "פענוח וקידוד מחדש של האודיו", seconds: audio.seconds / (PRIORS.local.decodeRtf * Math.max(0.35, cpuRatio)) });

  const inf = withThermalThrottle(audio.seconds, t.rtf, { mobile: device.mobile });
  phases.push({ id: "infer", label: "תמלול", seconds: inf.seconds });

  const total = phases.reduce((s, p) => s + p.seconds, 0);
  return { phases, total, rtf: t, thermal: inf };
}

function estimateColab(ctx) {
  const { audio, device, colab } = ctx;
  const gpu = colab?.gpu || "T4";
  const rtf = PRIORS.colab.rtf[gpu] ?? PRIORS.colab.rtf.T4;
  const warm = !!colab?.sessionWarm;
  const up = bytesPerSec(device.network.uplinkMbps, 0.8);
  const phases = [
    { id: "upload", label: "העלאת הקובץ (Drive/‏VM)", seconds: audio.bytes / up },
    { id: "alloc", label: `הקצאת מכונה עם ${gpu}`, seconds: warm ? PRIORS.colab.warmAllocSec : PRIORS.colab.allocSec },
    { id: "setup", label: "התקנת faster-whisper ומשקולות ivrit-ai", seconds: warm ? PRIORS.colab.warmSetupSec : PRIORS.colab.setupSec },
    { id: "infer", label: `תמלול על ה-${gpu}`, seconds: audio.seconds / rtf },
    { id: "fetch", label: "החזרת התמלול", seconds: 4 },
  ];
  return { phases, total: phases.reduce((s, p) => s + p.seconds, 0), rtf: { rtf, source: "prior", backend: gpu } };
}

function estimateActions(ctx) {
  const { audio, device } = ctx;
  const up = bytesPerSec(device.network.uplinkMbps, 0.8);
  const rtf = PRIORS.actions.rtf;
  const phases = [
    { id: "upload", label: "העלאה ל-Google Drive", seconds: audio.bytes / up },
    { id: "queue", label: "המתנה ל-runner של GitHub", seconds: PRIORS.actions.queueSec },
    { id: "setup", label: "התקנת סביבה ומשקולות", seconds: PRIORS.actions.setupSec },
    { id: "infer", label: "תמלול על 4 ליבות CPU", seconds: audio.seconds / rtf },
    { id: "fetch", label: "כתיבת התוצאה חזרה ל-Drive", seconds: PRIORS.actions.deliverSec },
  ];
  return { phases, total: phases.reduce((s, p) => s + p.seconds, 0), rtf: { rtf, source: "prior", backend: "ubuntu-latest 4vCPU" } };
}

// ── risk ────────────────────────────────────────────────────────────────────

function riskLocal(ctx, timing) {
  const { audio, device, model, opts } = ctx;
  const items = [];

  // Working set: ONNX keeps the weights plus arena overhead, and the whole
  // decoded PCM sits alongside it.
  const pcmBytes = audio.seconds * 16000 * 2;                  // int16 @ 16 kHz
  const decodePeak = audio.decodeInMemory
    ? audio.seconds * (audio.sampleRate || 44100) * (audio.channels || 1) * 4
    : 0;
  const need = model.bytes * 1.3 + pcmBytes + decodePeak + 260 * 1024 ** 2;
  const budget = memoryBudgetBytes(device);
  const pOom = logistic(need / budget, 0.85, 0.55);
  items.push({
    id: "oom", p: pOom, label: "הדפדפן ייחנק בזיכרון והלשונית תיסגר",
    detail: `דרוש ~${(need / GB).toFixed(1)} GB מול תקציב של ~${(budget / GB).toFixed(1)} GB` +
      (decodePeak ? ` (מזה ~${(decodePeak / GB).toFixed(1)} GB רק לפענוח הקובץ בפורמט הזה)` : ""),
    fix: decodePeak > budget * 0.4 ? "לפצל את ההקלטה, או לשלוח ל-Colab שלא צריך לפענח בנייד" : "לסגור אפליקציות אחרות לפני ההרצה",
  });

  // Storage for the model cache.
  if (!model.cached && model.bytes && device.storage.quotaBytes) {
    const free = device.storage.quotaBytes - (device.storage.usageBytes || 0);
    const pStore = logistic(model.bytes * 1.15 / Math.max(1, free), 0.9, 0.4);
    items.push({
      id: "storage", p: pStore, label: "אין מקום לשמור את המודל",
      detail: `המודל ${(model.bytes / GB).toFixed(2)} GB, פנוי לדפדפן ~${(free / GB).toFixed(1)} GB`,
      fix: "לפנות מקום במכשיר, או לבחור דיוק נמוך יותר (q4)",
    });
  }

  // The tab being evicted while it works. This is the dominant hazard on a
  // phone, and it grows with how long the job runs.
  const tau = opts?.wakeLock ? 2400 : 420;
  const pEvict = 1 - Math.exp(-timing.total / tau);
  items.push({
    id: "evict", p: pEvict, label: "המסך ייכבה / המערכת תהרוג את הלשונית באמצע",
    detail: opts?.wakeLock
      ? `Wake Lock פעיל, אבל ${Math.round(timing.total / 60)} דק׳ ברקע זה עדיין חלון פתוח למערכת`
      : "בלי Wake Lock אנדרואיד/iOS מקפיאים לשונית שרצה כמה דקות ברקע",
    fix: opts?.wakeLock ? "להשאיר את המסך דולק ואת האפליקציה בחזית" : "להפעיל Wake Lock ולהשאיר את המסך פתוח",
  });

  if (!model.cached && model.bytes) {
    const net = device.network.effectiveType;
    const base = net === "4g" ? 0.05 : net === "3g" ? 0.28 : net === "2g" || net === "slow-2g" ? 0.6 : 0.07;
    const size = clamp(model.bytes / (2 * GB), 0, 1) * 0.12;
    items.push({
      id: "download", p: clamp(base + size + (device.network.saveData ? 0.15 : 0), 0, 0.9),
      label: "הורדת המודל תיקטע",
      detail: `${(model.bytes / GB).toFixed(2)} GB${net ? ` על חיבור ${net}` : ""}${device.network.saveData ? ", ומצב חיסכון בנתונים דולק" : ""}`,
      fix: "להוריד פעם אחת על Wi-Fi; אחרי זה המודל שמור במכשיר",
    });
  }

  if (!device.gpu.webgpu) {
    items.push({
      id: "nowebgpu", p: 0.45, label: "אין WebGPU — ריצה על CPU בלבד",
      detail: device.gpu.error || "הדפדפן לא חושף WebGPU",
      fix: "Chrome עדכני באנדרואיד; ב-iOS צריך Safari 18+ עם WebGPU מופעל",
    });
  } else if (device.gpu.limits?.maxBufferSize && model.bytes) {
    // A single ONNX weight tensor has to fit in one GPU buffer.
    const pBuf = model.bytes / 6 > device.gpu.limits.maxBufferSize ? 0.3 : 0.03;
    if (pBuf > 0.1) items.push({
      id: "gpubuf", p: pBuf, label: "מגבלת גודל buffer ב-GPU",
      detail: `maxBufferSize = ${(device.gpu.limits.maxBufferSize / 1024 ** 2).toFixed(0)} MB`,
      fix: "לבחור וריאנט q4 של המודל",
    });
  }

  if (device.battery.supported && !device.battery.charging) {
    const drainFrac = (PRIORS.local.sustainedWatts * (timing.total / 3600)) / PRIORS.battery.phoneWh;
    const left = device.battery.level - drainFrac;
    items.push({
      id: "battery", p: clamp(logistic(-left, -0.08, 0.2), 0, 0.9),
      label: "הסוללה תיגמר לפני הסוף",
      detail: `${Math.round(device.battery.level * 100)}% עכשיו, צריכה משוערת ${Math.round(drainFrac * 100)}%`,
      fix: "לחבר למטען — זה גם מוריד את ההשפעה של הוויסות התרמי",
    });
  }

  return items;
}

function riskColab(ctx, timing) {
  const { audio, device, colab } = ctx;
  const paid = !!colab?.paid;
  const items = [
    {
      id: "nogpu", p: paid ? PRIORS.colab.pNoGpuPaid : PRIORS.colab.pNoGpuFree,
      label: "Colab לא יקצה GPU", detail: paid ? "מנוי בתשלום — נדיר" : "בחשבון חינמי זה קורה בשעות עומס",
      fix: "לנסות שוב מאוחר יותר, או להריץ על CPU (איטי בהרבה)",
    },
    {
      id: "upload", p: clamp(0.04 + (audio.bytes / GB) * 0.09 + (device.network.effectiveType === "3g" ? 0.15 : 0), 0, 0.8),
      label: "ההעלאה מהנייד תיכשל", detail: `${(audio.bytes / 1024 ** 2).toFixed(0)} MB להעלות`,
      fix: "להעלות על Wi-Fi; האפליקציה מחדשת העלאה שנקטעה",
    },
    {
      id: "disconnect", p: clamp(PRIORS.colab.pDisconnect90min * (timing.total / 5400), 0, 0.7),
      label: "הסשן יתנתק באמצע", detail: `זמן ריצה משוער ${Math.round(timing.total / 60)} דק׳`,
      fix: "התמלול נכתב ל-Drive בחתיכות, אז ניתוק לא מאבד את מה שכבר נעשה",
    },
    { id: "auth", p: 0.03, label: "תוקף ההרשאה ל-Drive יפוג", detail: "טוקן OAuth חי כשעה", fix: "האפליקציה מרעננת אוטומטית" },
  ];
  return items;
}

function riskActions(ctx, timing) {
  const { audio, device } = ctx;
  const items = [
    {
      id: "timeout", p: logistic(timing.total / PRIORS.actions.jobLimitSec, 0.8, 0.5),
      label: "ה-job יעבור את מגבלת 6 השעות של GitHub",
      detail: `זמן ריצה משוער ${(timing.total / 3600).toFixed(1)} שעות מתוך 6`,
      fix: "לפצל את ההקלטה, או להעדיף Colab עם GPU",
    },
    {
      id: "upload", p: clamp(0.04 + (audio.bytes / GB) * 0.09, 0, 0.8),
      label: "ההעלאה ל-Drive תיכשל", detail: `${(audio.bytes / 1024 ** 2).toFixed(0)} MB`,
      fix: "להעלות על Wi-Fi",
    },
    { id: "secrets", p: 0.05, label: "ה-service account לא יצליח לגשת לקובץ", detail: "התיקייה ב-Drive צריכה להיות משותפת עם כתובת ה-service account", fix: "לבדוק שיתוף בתיקייה" },
    { id: "runner", p: 0.03, label: "תקלה בצד GitHub (runner/רשת)", detail: "", fix: "הרצה חוזרת" },
  ];
  if (device.network.saveData) items.push({ id: "savedata", p: 0.08, label: "מצב חיסכון בנתונים עלול לקטוע את ההעלאה", detail: "", fix: "לכבות זמנית" });
  return items;
}

// ── device impact ───────────────────────────────────────────────────────────

function impactFor(route, ctx, timing) {
  const { device } = ctx;
  const hours = timing.total / 3600;
  if (route === "local") {
    const webgpu = device.gpu.webgpu;
    const cores = device.cores || 4;
    const cpuShare = webgpu ? 1 / cores : clamp((cores - 1) / cores, 0.25, 0.95);
    const watts = PRIORS.local.sustainedWatts * (webgpu ? 1 : 0.85);
    const perHour = (watts / PRIORS.battery.phoneWh) * 100;
    const wanted = perHour * hours;
    const level = device.battery.level ?? 1;
    return {
      level: webgpu ? "high" : "severe",
      cpuShare, gpuShare: webgpu ? 0.9 : 0,
      jankPct: webgpu ? 0.35 : 0.6,
      otherAppsSlowdown: webgpu ? 1.8 : 2.6,
      watts,
      batteryPctPerHour: perHour,
      batteryTotalPct: Math.min(100, wanted),
      batteryNeededPct: wanted,
      // Null when the job fits inside the charge that is already in the phone.
      batteryEmptyAfterSec: wanted > level * 100 ? (level * 100 / perHour) * 3600 : null,
      heat: timing.total > PRIORS.thermal.onsetSec ? (timing.total > 900 ? "המכשיר יתחמם מאוד" : "המכשיר יתחמם") : "חימום קל",
      summary: webgpu
        ? "ה-GPU תפוס כמעט לגמרי: גלילה ואנימציות יקפצו, אפליקציות אחרות יגיבו לאט, והמכשיר יתחמם"
        : "כמעט כל הליבות תפוסות: המכשיר יהיה איטי מאוד לאורך כל ההרצה",
    };
  }
  // Cloud routes: the phone only pushes bytes and then polls.
  const upSec = timing.phases.find((p) => p.id === "upload")?.seconds || 0;
  const watts = (PRIORS.battery.uploadWatts * upSec + PRIORS.battery.idleWatts * (timing.total - upSec)) / Math.max(1, timing.total);
  return {
    level: "low", cpuShare: 0.05, gpuShare: 0, jankPct: 0.02, otherAppsSlowdown: 1.02,
    watts,
    batteryPctPerHour: (watts / PRIORS.battery.phoneWh) * 100,
    batteryTotalPct: Math.min(100, (watts * hours / PRIORS.battery.phoneWh) * 100),
    batteryNeededPct: (watts * hours / PRIORS.battery.phoneWh) * 100,
    batteryEmptyAfterSec: null,
    heat: "בלי חימום ממשי",
    summary: `הנייד רק מעלה את הקובץ (${Math.round(upSec)} שנ׳) ואז ממתין — אפשר לנעול את המסך ולהמשיך להשתמש במכשיר רגיל`,
  };
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * @param {"local"|"colab"|"actions"} route
 * @param {object} ctx {audio, device, bench, model, calib, opts, colab}
 */
export function estimateRoute(route, ctx) {
  const timing =
    route === "local" ? estimateLocal(ctx) :
    route === "colab" ? estimateColab(ctx) :
    estimateActions(ctx);

  const items = (
    route === "local" ? riskLocal(ctx, timing) :
    route === "colab" ? riskColab(ctx, timing) :
    riskActions(ctx, timing)
  ).filter((i) => i.p > 0.005).sort((a, b) => b.p - a.p);

  const totalRisk = combine(items.map((i) => i.p));

  // Uncertainty band: wide while the numbers are priors, tight once this phone
  // has actually finished a run of its own.
  const measured = timing.rtf?.source === "measured";
  const n = timing.rtf?.n || 0;
  const spread = route === "local"
    ? (measured ? clamp(1.45 - 0.06 * n, 1.18, 1.45) : 1.85)
    : 1.6;

  return {
    route,
    phases: timing.phases,
    seconds: timing.total,
    p50: timing.total,
    p90: timing.total * spread,
    rtf: timing.rtf,
    thermal: timing.thermal || null,
    risk: { total: totalRisk, items },
    impact: impactFor(route, ctx, timing),
    confidence: measured ? { level: "measured", n, note: `מכויל לפי ${n} ריצות קודמות במכשיר הזה` }
                         : { level: "prior", n: 0, note: "הערכה ראשונית — תתכייל אחרי הריצה הראשונה" },
  };
}

export function estimateAll(ctx) {
  return { local: estimateRoute("local", ctx), colab: estimateRoute("colab", ctx), actions: estimateRoute("actions", ctx) };
}

/**
 * Picks a route by expected cost, not by raw speed: a fast route that fails
 * half the time costs two attempts, and a route that makes the phone unusable
 * for an hour has a real price too.
 */
export function recommend(estimates, { availability = {}, careAboutPhone = true } = {}) {
  const cost = (e) => {
    const attempts = 1 / Math.max(0.15, 1 - e.risk.total);   // a route that fails half the time costs two runs
    const impactPenalty = careAboutPhone
      ? e.seconds * (e.impact.level === "severe" ? 0.9 : e.impact.level === "high" ? 0.5 : 0)
      : 0;
    return e.seconds * attempts + impactPenalty;
  };

  const scored = Object.values(estimates).map((e) => ({
    route: e.route, est: e, cost: cost(e), blocked: availability[e.route] === false,
  }));

  const usable = scored.filter((r) => !r.blocked).sort((a, b) => a.cost - b.cost);
  const overall = scored.slice().sort((a, b) => a.cost - b.cost);
  const ranking = [...usable, ...scored.filter((r) => r.blocked).sort((a, b) => a.cost - b.cost)];
  const best = usable[0] || overall[0];

  const why = [];
  if (best.est.risk.total < 0.15) why.push("סיכון הכישלון הנמוך ביותר");
  if (best.route !== "local") why.push("לא מעמיס על הנייד");
  if (ranking.length > 1 && best.est.seconds < ranking[1].est.seconds) why.push("הכי מהיר");

  // Only claim a recommendation when it is one. If a better route exists but is
  // not set up yet, say that instead of blessing a bad fallback.
  const betterExists = overall[0].route !== best.route && overall[0].blocked;
  return {
    route: best.route,
    ranking,
    why,
    confident: !betterExists && !(best.est.risk.total > 0.5),
    bestIfConfigured: betterExists ? overall[0] : null,
    onlyOption: usable.length <= 1,
  };
}

export const ROUTE_LABELS = {
  local: "על המכשיר (WebGPU)",
  colab: "Google Colab (GPU)",
  actions: "GitHub Actions (שרת git)",
};
