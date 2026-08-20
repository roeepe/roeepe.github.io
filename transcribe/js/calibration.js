// Turns every completed run into evidence, so the next estimate is grounded in
// what this phone actually did rather than in PRIORS. Kept in localStorage,
// keyed by a device signature so a browser/hardware change starts fresh.

import { store, ewma } from "./util.js";

const KEY = "calib.v1";

const empty = () => ({ sig: null, routes: {}, history: [] });

function sig() {
  return [navigator.hardwareConcurrency, navigator.deviceMemory, navigator.userAgent].join("|");
}

export function loadCalibration() {
  const c = store.get(KEY, null);
  if (!c || c.sig !== sig()) return { ...empty(), sig: sig() };
  return c;
}

export function resetCalibration() {
  store.set(KEY, { ...empty(), sig: sig() });
}

/**
 * @param {object} run
 *   route          "local" | "colab" | "actions"
 *   audioSeconds   length of the audio that was transcribed
 *   inferSeconds   wall time spent in the transcription phase alone
 *   totalSeconds   wall time of the whole job
 *   backend        "webgpu" | "wasm" | "T4" | …
 *   ok             did it finish
 *   phases         {id: seconds} actually observed
 *   battery        {startLevel, endLevel} if the browser exposed it
 *   jankPct        share of frames slower than 32 ms during the run
 */
export function recordRun(run) {
  const c = loadCalibration();
  const r = (c.routes[run.route] ||= { rtf: null, phases: {}, runs: 0, fails: 0, backend: run.backend });
  r.runs++;
  if (!run.ok) { r.fails++; }
  r.backend = run.backend || r.backend;

  if (run.ok && run.audioSeconds > 5 && run.inferSeconds > 0.5) {
    r.rtf = ewma(r.rtf, run.audioSeconds / run.inferSeconds);
  }
  for (const [id, sec] of Object.entries(run.phases || {})) {
    if (sec > 0) r.phases[id] = ewma(r.phases[id], sec);
  }
  if (run.battery?.startLevel != null && run.battery?.endLevel != null && run.totalSeconds > 120) {
    const drain = (run.battery.startLevel - run.battery.endLevel) / (run.totalSeconds / 3600);
    if (drain > 0) r.batteryPerHour = ewma(r.batteryPerHour, drain);
  }
  if (run.jankPct != null) r.jankPct = ewma(r.jankPct, run.jankPct);

  c.history.unshift({
    at: Date.now(), route: run.route, ok: !!run.ok, backend: run.backend,
    audioSeconds: run.audioSeconds, totalSeconds: run.totalSeconds,
    inferSeconds: run.inferSeconds, estimatedSeconds: run.estimatedSeconds ?? null,
    error: run.error || null,
  });
  c.history = c.history.slice(0, 40);
  store.set(KEY, c);
  return c;
}

/** How close previous predictions came — shown in the UI so the numbers stay honest. */
export function accuracyReport(calib) {
  const rows = (calib.history || []).filter((h) => h.ok && h.estimatedSeconds > 0 && h.totalSeconds > 0);
  if (!rows.length) return null;
  const ratios = rows.map((h) => h.totalSeconds / h.estimatedSeconds).sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  const within = ratios.filter((r) => r > 0.6 && r < 1.6).length / ratios.length;
  return { n: rows.length, medianRatio: median, withinBand: within };
}
