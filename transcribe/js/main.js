// Wiring. Everything interesting lives in the modules; this file decides what
// the screen shows and which route actually gets run.

import { $, fmtBytes, fmtDuration, pct, download, store, clamp } from "./util.js";
import { probeDevice, describeDevice, memoryBudgetBytes } from "./device.js";
import { getBenchmark } from "./bench.js";
import { probeAudio } from "./audio.js";
import { estimateAll, recommend, ROUTE_LABELS } from "./estimator.js";
import { loadCalibration, recordRun, resetCalibration, accuracyReport } from "./calibration.js";
import { CATALOG, resolveModel, pickDtype, cacheState, clearModelCache } from "./models.js";
import { LocalRun } from "./local-run.js";
import { EXPORTS } from "./formats.js";
import * as drive from "./google.js";
import * as colab from "./colab.js";
import * as gh from "./ghactions.js";

const S = {
  file: null, info: null, device: null, bench: null,
  resolved: null, dtype: null, model: null,
  estimates: null, recommendation: null,
  run: null, abort: null, result: null, startedAt: 0, estimatedSeconds: 0,
};

const settings = {
  get modelRepo() { return store.get("s.modelRepo", CATALOG[0].id); },
  get dtypeOverride() { return store.get("s.dtype", "auto"); },
  get ct2Model() { return store.get("s.ct2", colab.DEFAULT_CT2_MODEL); },
  get segmentSec() { return store.get("s.segment", 600); },
  get wakeLock() { return store.get("s.wakelock", true); },
  get resume() { return store.get("s.resume", true); },
};

const log = (msg) => {
  const el = $("#run-log");
  el.textContent += `${new Date().toLocaleTimeString("he-IL")}  ${msg}\n`;
  el.scrollTop = el.scrollHeight;
};

// ── startup ─────────────────────────────────────────────────────────────────

async function init() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* offline shell is optional */ });
  }
  S.device = await probeDevice();
  renderDeviceFacts();
  wireSettings();
  wireInput();
  renderExports();

  const pending = LocalRun.pendingResume();
  if (pending && settings.resume) {
    log(`נמצאה ריצה שנקטעה על ${pending.fileName} (${pending.results?.length || 0} מקטעים מוכנים) — בחרו שוב את אותו קובץ כדי להמשיך`);
    $("#run-log-fold").open = true;
    $("#sec-run").hidden = false;
    $("#run-title").textContent = "ריצה קודמת נקטעה";
    $("#btn-cancel").hidden = true;
  }
}

function renderDeviceFacts() {
  const d = S.device;
  const rows = [
    ["מכשיר", describeDevice(d)],
    ["ליבות", d.cores ?? "לא נחשף"],
    ["זיכרון", d.memoryGB ? `${d.memoryGB}${d.memoryIsCapped ? "+" : ""} GB (תקציב ~${(memoryBudgetBytes(d) / 1024 ** 3).toFixed(1)} GB)` : "לא נחשף"],
    ["WebGPU", d.gpu.webgpu ? [d.gpu.adapter?.vendor, d.gpu.adapter?.architecture].filter(Boolean).join(" ") || "זמין" : (d.gpu.error || "לא זמין")],
    ["אחסון פנוי לדפדפן", d.storage.quotaBytes ? fmtBytes(d.storage.quotaBytes - (d.storage.usageBytes || 0)) : "לא נחשף"],
    ["רשת", d.network.effectiveType ? `${d.network.effectiveType} · ~${d.network.downlinkMbps} Mb/s` : "לא נחשף"],
    ["סוללה", d.battery.supported ? `${Math.round(d.battery.level * 100)}%${d.battery.charging ? " · בטעינה" : ""}` : "לא נחשף"],
    ["Wake Lock", d.wakeLock ? "נתמך" : "לא נתמך"],
  ];
  if (S.bench) {
    rows.push(["מדידת GPU", S.bench.gpuGflops ? `${S.bench.gpuGflops.toFixed(0)} GFLOP/s` : (S.bench.gpuError || "—")]);
    rows.push(["מדידת CPU", S.bench.cpuGflops ? `${S.bench.cpuGflops.toFixed(2)} GFLOP/s` : "—"]);
  }
  $("#device-facts").innerHTML = rows.map(([k, v]) =>
    `<div><dt>${k}</dt><dd>${escapeHtml(String(v))}</dd></div>`).join("");
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── picking a recording ─────────────────────────────────────────────────────

function wireInput() {
  $("#file").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) onFile(f); });
  $("#btn-record").addEventListener("click", toggleRecording);
  $("#btn-rebench").addEventListener("click", async () => {
    S.bench = await getBenchmark({ adapter: S.device.gpu._adapter, force: true });
    renderDeviceFacts();
    if (S.file) refreshEstimate();
  });
  $("#btn-cancel").addEventListener("click", cancelRun);
}

async function onFile(file) {
  S.file = file;
  S.result = null;
  $("#sec-result").hidden = true;
  $("#file-card").hidden = false;

  $("#f-name").textContent = file.name;
  $("#f-size").textContent = fmtBytes(file.size);
  $("#f-format").textContent = file.type || "לא ידוע";
  $("#f-duration").textContent = "בודק…";

  S.info = await probeAudio(file);
  $("#f-duration").textContent = S.info.seconds ? fmtDuration(S.info.seconds) : "לא ידוע";
  $("#f-format").textContent = `${S.info.container || file.type || "?"}${S.info.sampleRate ? ` · ${(S.info.sampleRate / 1000).toFixed(1)} kHz` : ""}`;
  $("#f-note").textContent = S.info.sliceable
    ? "WAV — אפשר לקרוא אותו במקטעים, כך שגם הקלטה ארוכה לא תופסת זיכרון."
    : "פורמט דחוס — הדפדפן חייב לפענח אותו בשלמותו לפני תמלול מקומי; זה נלקח בחשבון בהערכה למטה.";

  if (!S.info.seconds) {
    $("#f-note").textContent = "לא הצלחתי לקרוא את אורך ההקלטה. אפשר עדיין להריץ, אבל בלי הערכת זמן.";
    return;
  }
  await refreshEstimate();
}

// ── the estimate ────────────────────────────────────────────────────────────

async function refreshEstimate() {
  $("#sec-estimate").hidden = false;
  $("#est-basis").textContent = "מודד את המכשיר…";
  $("#routes").innerHTML = "";

  if (!S.bench) {
    S.bench = await getBenchmark({ adapter: S.device.gpu._adapter });
    renderDeviceFacts();
  }

  $("#est-basis").textContent = "בודק אילו קבצים צריך להוריד…";
  await refreshModel();

  const calib = loadCalibration();
  const ctx = {
    audio: {
      seconds: S.info.seconds, bytes: S.file.size,
      sampleRate: S.info.sampleRate, channels: S.info.channels,
      decodeInMemory: S.info.decodeInMemory,
    },
    device: S.device, bench: S.bench, calib,
    model: S.model || { bytes: 1.6 * 1024 ** 3, cached: false, dtypeLabel: "לא ידוע" },
    opts: { wakeLock: settings.wakeLock && S.device.wakeLock },
    colab: { gpu: "T4", paid: false, sessionWarm: false },
  };

  S.estimates = estimateAll(ctx);
  S.recommendation = recommend(S.estimates, {
    availability: {
      local: !!S.model,
      colab: !!drive.getClientId(),
      actions: !!(drive.getClientId() && gh.config.configured),
    },
  });
  renderRoutes();

  const acc = accuracyReport(calib);
  const local = S.estimates.local;
  $("#est-basis").textContent = [
    local.confidence.note,
    acc ? `דיוק ההערכות עד כה: חציון ×${acc.medianRatio.toFixed(2)} על ${acc.n} ריצות` : null,
  ].filter(Boolean).join(" · ");
}

async function refreshModel() {
  const repoId = settings.modelRepo;
  try {
    if (!S.resolved || S.resolved.repoId !== repoId) S.resolved = await resolveModel(repoId);
    const budget = memoryBudgetBytes(S.device);
    const override = settings.dtypeOverride;
    const opt = override !== "auto"
      ? S.resolved.options.find((o) => o.id === override) || pickDtype(S.resolved, { budgetBytes: budget })
      : pickDtype(S.resolved, { budgetBytes: budget, preferSmall: !!S.device.mobile });
    S.dtype = opt;
    const cache = await cacheState(opt);
    S.model = { repoId, dtype: opt.id, dtypeLabel: opt.label, bytes: opt.bytes, cached: cache.cached, cacheRatio: cache.ratio };
    fillDtypeSelect();
  } catch (e) {
    S.model = null;
    log(`לא הצלחתי לקרוא את פרטי המודל: ${e.message}`);
  }
}

function riskClass(p) { return p < 0.12 ? "ok" : p < 0.35 ? "warn" : "bad"; }

function renderRoutes() {
  const rec = S.recommendation;
  const order = rec.ranking.map((r) => r.route);
  const banner = rec.bestIfConfigured ? `
    <p class="impact high" id="better-route">
      המסלול המהיר ביותר להקלטה הזאת הוא <strong>${ROUTE_LABELS[rec.bestIfConfigured.route]}</strong>
      — ‏≈${fmtDuration(rec.bestIfConfigured.est.p50)} בסיכון ${pct(rec.bestIfConfigured.est.risk.total)},
      במקום ${fmtDuration(S.estimates[rec.route].p50)} בסיכון ${pct(S.estimates[rec.route].risk.total)}.
      חסרה רק הגדרה אחת: ${rec.bestIfConfigured.route === "colab"
        ? "Google OAuth Client ID במסך ההגדרות"
        : "Client ID של Google וטוקן GitHub במסך ההגדרות"}.
    </p>` : "";

  $("#routes").innerHTML = banner +
    order.map((route) => routeCard(S.estimates[route], route === rec.route && rec.confident)).join("");

  for (const btn of document.querySelectorAll("[data-run]")) {
    btn.addEventListener("click", () => startRun(btn.dataset.run));
  }
}

function routeCard(e, best) {
  const blocked = S.recommendation.ranking.find((r) => r.route === e.route)?.blocked;
  const reason = e.route === "local" ? "צריך מודל תקין" : e.route === "colab" ? "צריך Google Client ID בהגדרות" : "צריך Client ID וגם טוקן GitHub";
  const modelLine = e.route === "local" && S.model
    ? `<p class="hint">${escapeHtml(S.model.dtypeLabel)} · ${fmtBytes(S.model.bytes)} · ${S.model.cached ? "כבר במכשיר" : "טרם הורד"}</p>`
    : e.route !== "local" ? `<p class="hint">${escapeHtml(settings.ct2Model)}</p>` : "";

  return `
  <article class="route${best ? " best" : ""}">
    <div class="route-head">
      <span class="route-name">${ROUTE_LABELS[e.route]}</span>
      ${best ? '<span class="badge">מומלץ</span>'
        : (e.route === S.recommendation.route ? '<span class="badge ghost">היחיד שמוגדר כרגע</span>' : "")}
      <span class="badge ghost">${e.rtf.source === "measured" ? "מכויל" : "הערכה"} · ${fmtRtf(e)}</span>
    </div>
    ${modelLine}
    <p class="time">≈ ${fmtDuration(e.p50)}<small>עד ${fmtDuration(e.p90)}</small></p>

    <div class="meter">
      <span class="meter-label">סיכון כישלון</span>
      <div class="bar"><div class="bar-fill ${riskClass(e.risk.total)}" style="width:${clamp(e.risk.total, 0.02, 1) * 100}%"></div></div>
      <span class="meter-label ${riskClass(e.risk.total)}">${pct(e.risk.total)}</span>
    </div>

    <div class="impact ${e.impact.level}">
      <strong>השפעה על המכשיר:</strong> ${e.impact.summary}.
      סוללה ~${Math.round(e.impact.batteryTotalPct)}% (${Math.round(e.impact.batteryPctPerHour)}%/שעה)${
        e.impact.batteryEmptyAfterSec ? ` — לפי הרמה הנוכחית הסוללה תיגמר אחרי ${fmtDuration(e.impact.batteryEmptyAfterSec)}` : ""
      }. ${e.impact.heat}.
    </div>

    <details class="foldout">
      <summary>מה עלול להשתבש (${e.risk.items.length})</summary>
      <ul class="risk-list">
        ${e.risk.items.map((i) => `
          <li>
            <span><span class="risk-p ${riskClass(i.p)}">${pct(i.p)}</span>${escapeHtml(i.label)}</span>
            ${i.detail ? `<span class="risk-fix">${escapeHtml(i.detail)}</span>` : ""}
            ${i.fix ? `<span class="risk-fix">↩ ${escapeHtml(i.fix)}</span>` : ""}
          </li>`).join("")}
      </ul>
    </details>

    <details class="foldout">
      <summary>מאיפה מגיע הזמן</summary>
      <ul class="phases">
        ${e.phases.map((p) => `<li><span>${escapeHtml(p.label)}</span><span class="p-time">${fmtDuration(p.seconds)}</span></li>`).join("")}
        ${e.thermal?.lost > 30 ? `<li><span>מזה בגלל ויסות תרמי</span><span class="p-time">+${fmtDuration(e.thermal.lost)}</span></li>` : ""}
      </ul>
    </details>

    <div class="pickers">
      <button class="btn ${best ? "primary" : ""}" data-run="${e.route}" ${blocked ? "disabled" : ""}>הרצה</button>
      ${blocked ? `<span class="hint">${reason}</span>` : ""}
    </div>
  </article>`;
}

function fmtRtf(e) {
  const r = e.rtf.rtf;
  return r >= 1 ? `פי ${r.toFixed(r < 10 ? 1 : 0)} מהזמן אמת` : `פי ${(1 / r).toFixed(1)} איטי מהזמן אמת`;
}

// ── running ─────────────────────────────────────────────────────────────────

function showRun(title) {
  $("#sec-run").hidden = false;
  $("#run-title").textContent = title;
  $("#run-log").textContent = "";
  $("#run-bar").style.width = "0%";
  $("#run-live").innerHTML = "";
  $("#btn-cancel").hidden = false;
  $("#btn-external").hidden = true;
  $("#sec-run").scrollIntoView({ behavior: "smooth", block: "start" });
}

function setProgress(ratio, stage) {
  $("#run-bar").style.width = `${clamp(ratio, 0, 1) * 100}%`;
  if (stage) $("#run-stage").textContent = stage;
  $("#run-pct").textContent = ratio > 0 ? pct(ratio) : "";
}

function liveFacts(rows) {
  $("#run-live").innerHTML = rows.filter(Boolean)
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(String(v))}</dd></div>`).join("");
}

function startRun(route) {
  S.startedAt = performance.now();
  S.estimatedSeconds = S.estimates?.[route]?.p50 || 0;
  if (route === "local") return runLocal();
  if (route === "colab") return runColab();
  return runActions();
}

function cancelRun() {
  S.run?.cancel?.();
  S.abort?.abort?.();
  log("בוטל על ידי המשתמש");
}

async function runLocal() {
  showRun("מתמלל על המכשיר");
  const device = S.device.gpu.webgpu ? "webgpu" : "wasm";
  log(`מסלול מקומי · ${S.model.repoId} · ${S.model.dtype} · ${device}`);

  const run = new LocalRun();
  S.run = run;

  run.addEventListener("phase", (e) => setProgress(0.02, e.detail.label));
  run.addEventListener("phase-done", (e) => log(`${e.detail.id}: ${e.detail.seconds.toFixed(1)} שנ׳`));
  run.addEventListener("wakelock", (e) => log(e.detail.acquired ? "Wake Lock פעיל — המסך יישאר דולק" : "Wake Lock לא זמין — כדאי להשאיר את המסך פתוח ידנית"));
  run.addEventListener("resumed", (e) => log(`ממשיך ריצה קודמת: ${e.detail.done} מתוך ${e.detail.of} מקטעים`));

  run.addEventListener("progress", (e) => {
    const m = e.detail;
    if (m.type === "load-progress") {
      setProgress(m.ratio * 0.25, `מוריד את המודל · ${fmtBytes(m.loaded)} מתוך ${fmtBytes(m.total)}`);
    } else if (m.type === "decode") {
      setProgress(0.25 + (m.ratio || 0) * 0.05, m.label || "מפענח");
    }
  });

  run.addEventListener("segment", (e) => {
    const d = e.detail;
    setProgress(0.3 + d.ratio * 0.7, `מתמלל · מקטע ${d.index + 1} מתוך ${d.of}`);
    liveFacts([
      ["מהירות בפועל", `פי ${d.observedRtf.toFixed(2)} מזמן אמת`],
      ["נותר", fmtDuration(d.etaSec)],
      ["פריימים תקועים", pct(d.jankPct)],
      ["תמלול עד כה", `${d.audioDone.toFixed(0)} מתוך ${d.audioTotal.toFixed(0)} שניות`],
    ]);
    log(`מקטע ${d.index + 1}: ${d.text.slice(0, 80)}${d.text.length > 80 ? "…" : ""}`);
  });

  run.addEventListener("telemetry", (e) => {
    const t = e.detail;
    if (t.batteryLevel != null) {
      const el = $("#run-live");
      if (el.children.length) el.insertAdjacentHTML("beforeend",
        `<div><dt>סוללה</dt><dd>${Math.round(t.batteryLevel * 100)}%${t.charging ? " ⚡" : ""}</dd></div>`);
    }
  });

  const res = await run.run(S.file, S.info, {
    repoId: S.model.repoId, dtype: S.model.dtype, device,
    language: "he", segmentSec: settings.segmentSec,
    keepScreenOn: settings.wakeLock, resume: settings.resume,
  });
  run.dispose();
  S.run = null;

  recordRun({
    route: "local", ok: res.ok, backend: device,
    audioSeconds: res.audioSeconds || S.info.seconds,
    inferSeconds: res.timing?.infer, totalSeconds: res.totalSeconds,
    estimatedSeconds: S.estimatedSeconds,
    phases: res.timing, jankPct: res.telemetry?.jankPct,
    battery: { startLevel: res.telemetry?.batteryDrop != null ? S.device.battery.level : null,
               endLevel: res.telemetry?.batteryDrop != null ? S.device.battery.level - res.telemetry.batteryDrop : null },
    error: res.error,
  });

  if (res.telemetry) {
    log(`נמדד: ${res.telemetry.jankPct != null ? `${pct(res.telemetry.jankPct)} פריימים תקועים` : ""}` +
        `${res.telemetry.batteryPctPerHour != null ? ` · ${res.telemetry.batteryPctPerHour.toFixed(1)}% סוללה לשעה` : ""}`);
  }
  if (!res.ok) log(`נכשל: ${res.error || "בוטל"} — הטקסט שכבר הופק נשמר למטה`);

  finishRun({ ...res, model: S.model.repoId, backend: device, audioSeconds: res.audioSeconds || S.info.seconds });
}

async function uploadForCloud(onProgress) {
  S.abort = new AbortController();
  await drive.signIn();
  const folderId = await drive.ensureFolder();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const audio = await drive.uploadFile(S.file, {
    name: `${stamp}__${S.file.name}`, parents: [folderId],
    signal: S.abort.signal, onProgress,
  });
  const result = await drive.createFile({
    name: `${stamp}__${S.file.name.replace(/\.[^.]+$/, "")}.result.json`,
    parents: [folderId],
    content: JSON.stringify({ status: "queued", createdAt: Date.now() }, null, 1),
  });
  return { folderId, audioId: audio.id, resultId: result.id };
}

async function runColab() {
  showRun("מכין עבודה ל-Colab");
  try {
    const job = await colab.createJob(S.file, {
      model: settings.ct2Model,
      onProgress: (p) => {
        if (p.stage === "upload" && p.ratio != null) setProgress(p.ratio * 0.5, `${p.label} · ${pct(p.ratio)}`);
        else setProgress(0.55, p.label);
        log(p.label);
      },
    });
    log(`מחברת נוצרה ב-Drive: ${job.notebookId}`);
    const link = $("#btn-external");
    link.href = job.colabUrl; link.hidden = false; link.textContent = "פתיחת המחברת ב-Colab";
    setProgress(0.6, "פתחו את המחברת ולחצו Runtime → Run all");
    liveFacts([
      ["מה עכשיו", "פתחו את Colab, ודאו GPU, ו-Run all"],
      ["הקלטה ב-Drive", job.audioName],
      ["מודל", job.model],
    ]);
    log("שורת הפקודה למחשב:\n" + colab.cliSnippet(job));
    $("#run-log-fold").open = true;
    window.open(job.colabUrl, "_blank", "noopener");
    await watchCloud(job.resultFileId, "colab");
  } catch (e) {
    log(`נכשל: ${e.message}`);
    setProgress(0, "נכשל");
  }
}

async function runActions() {
  showRun("שולח ל-GitHub Actions");
  try {
    const ids = await uploadForCloud((p) => setProgress(p.ratio * 0.4, `מעלה ל-Drive · ${pct(p.ratio)}`));
    log(`הועלה ל-Drive: ${ids.audioId}`);

    if (gh.config.serviceAccount) {
      setProgress(0.45, "משתף את הקבצים עם ה-service account");
      for (const id of [ids.audioId, ids.resultId]) {
        await drive.shareWith(id, gh.config.serviceAccount, "writer").catch((e) => log(`שיתוף נכשל: ${e.message}`));
      }
    } else {
      log("לא הוגדרה כתובת service account — ודאו שתיקיית ivrit-transcribe משותפת איתו ב-Drive");
    }

    setProgress(0.5, "מפעיל את ה-workflow");
    const run = await gh.dispatch({
      audioFileId: ids.audioId, resultFileId: ids.resultId, model: settings.ct2Model,
    });
    log(`workflow run: ${run.url}`);
    const link = $("#btn-external");
    link.href = run.url; link.hidden = false; link.textContent = "צפייה ב-GitHub Actions";
    await watchCloud(ids.resultId, "actions", run.id);
  } catch (e) {
    log(`נכשל: ${e.message}`);
    setProgress(0, "נכשל");
  }
}

/** Follows a cloud job through the Drive result file it keeps updating. */
async function watchCloud(resultFileId, route, runId = null) {
  S.abort = new AbortController();
  const t0 = performance.now();
  let lastStage = "";

  const payload = await drive.pollResult(resultFileId, {
    signal: S.abort.signal,
    onTick: ({ payload: p, error }) => {
      if (error) { log(error); return; }
      if (!p) return;
      const pr = p.progress || {};
      if (p.stage && p.stage !== lastStage) { lastStage = p.stage; log(`שלב: ${p.stage}`); }
      setProgress(0.6 + (pr.ratio || 0) * 0.4, p.stage || p.status);
      liveFacts([
        ["מצב", p.status],
        pr.rtf ? ["מהירות בפועל", `פי ${pr.rtf.toFixed(1)} מזמן אמת`] : null,
        pr.etaSec ? ["נותר", fmtDuration(pr.etaSec)] : null,
        p.meta?.gpu ? ["חומרה", p.meta.gpu] : null,
        ["הועבר", fmtDuration((performance.now() - t0) / 1000)],
      ]);
      if (p.text) $("#result-text").value = p.text;
    },
  }).catch((e) => ({ status: "error", error: e.message }));

  if (runId) {
    const st = await gh.runStatus(runId).catch(() => null);
    if (st) log(`GitHub: ${st.status}${st.conclusion ? ` (${st.conclusion})` : ""}`);
  }

  const wall = (performance.now() - t0) / 1000;
  const ok = payload.status === "done";
  recordRun({
    route, ok, backend: payload.meta?.gpu || payload.meta?.device || route,
    audioSeconds: payload.meta?.audioSec || S.info.seconds,
    inferSeconds: payload.meta?.inferSec || wall,
    totalSeconds: wall, estimatedSeconds: S.estimatedSeconds,
    phases: {}, error: payload.error,
  });

  if (!ok) { log(`נכשל: ${payload.error || "לא ידוע"}`); setProgress(0, "נכשל"); }
  finishRun({
    ok, text: payload.text || "", chunks: payload.segments || [],
    model: payload.meta?.model || settings.ct2Model,
    backend: payload.meta?.gpu || payload.meta?.device || route,
    audioSeconds: payload.meta?.audioSec || S.info.seconds,
    totalSeconds: wall, error: payload.error,
  });
}

function finishRun(res) {
  S.result = res;
  setProgress(res.ok ? 1 : 0, res.ok ? "הסתיים" : "נעצר");
  $("#btn-cancel").hidden = true;
  $("#sec-result").hidden = false;
  $("#result-text").value = res.text || "";

  const actual = res.totalSeconds || 0;
  const ratio = S.estimatedSeconds ? actual / S.estimatedSeconds : null;
  $("#result-meta").textContent = [
    res.ok ? "הושלם" : "הופסק — זה מה שהספיק להיות מתומלל",
    res.model, res.backend,
    `${fmtDuration(actual)} בפועל`,
    ratio ? `מול הערכה של ${fmtDuration(S.estimatedSeconds)} (×${ratio.toFixed(2)})` : null,
    res.audioSeconds ? `יחס: פי ${(res.audioSeconds / Math.max(1, actual)).toFixed(2)} מזמן אמת` : null,
  ].filter(Boolean).join(" · ");

  const acc = accuracyReport(loadCalibration());
  $("#accuracy-note").textContent = acc
    ? `ההערכות מתעדכנות: חציון סטייה ×${acc.medianRatio.toFixed(2)} על ${acc.n} ריצות, ${pct(acc.withinBand)} מהן בתוך הטווח שהוצג.`
    : "";
  if (S.file) refreshEstimate();
}

function renderExports() {
  $("#export-buttons").innerHTML = EXPORTS.map((e) =>
    `<button class="btn small" data-export="${e.id}">${e.label}</button>`).join("") +
    `<button class="btn small" data-export="copy">העתקה</button>`;

  $("#export-buttons").addEventListener("click", async (ev) => {
    const id = ev.target?.dataset?.export;
    if (!id || !S.result) return;
    const payload = { ...S.result, text: $("#result-text").value };
    if (id === "copy") {
      await navigator.clipboard.writeText(payload.text);
      ev.target.textContent = "הועתק ✓";
      setTimeout(() => { ev.target.textContent = "העתקה"; }, 1500);
      return;
    }
    const fmt = EXPORTS.find((e) => e.id === id);
    const base = (S.file?.name || "transcript").replace(/\.[^.]+$/, "");
    download(`${base}.${fmt.ext}`, fmt.build(payload), fmt.mime);
  });
}

// ── recording ───────────────────────────────────────────────────────────────

let recorder = null, recChunks = [], recStart = 0, recTimer = null;

async function toggleRecording() {
  if (recorder?.state === "recording") { recorder.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
    const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : {});
    recChunks = [];
    recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    recorder.onstop = () => {
      clearInterval(recTimer);
      stream.getTracks().forEach((t) => t.stop());
      $("#record-hint").hidden = true;
      $("#btn-record").textContent = "הקלטה חדשה";
      const blob = new Blob(recChunks, { type: recorder.mimeType });
      const ext = recorder.mimeType.includes("mp4") ? "m4a" : "webm";
      onFile(new File([blob], `הקלטה-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.${ext}`, { type: recorder.mimeType }));
    };
    recorder.start(1000);
    recStart = Date.now();
    $("#record-hint").hidden = false;
    $("#btn-record").textContent = "עצירת הקלטה";
    recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - recStart) / 1000);
      $("#record-time").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 500);
  } catch (e) {
    alert(`אין גישה למיקרופון: ${e.message}`);
  }
}

// ── settings ────────────────────────────────────────────────────────────────

function fillDtypeSelect() {
  const sel = $("#s-dtype");
  const options = S.resolved?.options || [];
  sel.innerHTML = `<option value="auto">אוטומטי (לפי הזיכרון במכשיר)</option>` +
    options.map((o) => `<option value="${o.id}">${escapeHtml(o.label)} · ${fmtBytes(o.bytes)}</option>`).join("");
  sel.value = settings.dtypeOverride;
  $("#s-model-note").textContent = S.model
    ? `נבחר ${S.model.dtypeLabel} · ${fmtBytes(S.model.bytes)} · ${S.model.cached ? "כבר במטמון" : `${pct(S.model.cacheRatio)} במטמון`}`
    : "לא הצלחתי לקרוא את המאגר";
}

function wireSettings() {
  const dlg = $("#settings");
  $("#btn-settings").addEventListener("click", () => dlg.showModal());

  $("#s-model").value = settings.modelRepo;
  $("#s-model-preset").innerHTML = `<option value="">— מודלים מוכנים —</option>` +
    CATALOG.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("");
  $("#s-model-preset").addEventListener("change", (e) => {
    if (!e.target.value) return;
    $("#s-model").value = e.target.value;
    store.set("s.modelRepo", e.target.value);
    S.resolved = null;
    if (S.file) refreshEstimate();
  });
  $("#s-model").addEventListener("change", (e) => {
    store.set("s.modelRepo", e.target.value.trim());
    S.resolved = null;
    if (S.file) refreshEstimate();
  });
  $("#s-dtype").addEventListener("change", (e) => {
    store.set("s.dtype", e.target.value);
    if (S.file) refreshEstimate();
  });

  $("#s-ct2").innerHTML = colab.CT2_MODELS.map((m) => `<option value="${m.id}">${escapeHtml(m.label)}</option>`).join("");
  $("#s-ct2").value = settings.ct2Model;
  $("#s-ct2").addEventListener("change", (e) => { store.set("s.ct2", e.target.value); if (S.file) refreshEstimate(); });

  $("#s-google-client").value = drive.getClientId();
  $("#s-google-client").addEventListener("change", (e) => { drive.setClientId(e.target.value); if (S.file) refreshEstimate(); });

  $("#s-gh-repo").value = gh.config.repo;
  $("#s-gh-ref").value = gh.config.ref;
  $("#s-gh-token").value = gh.config.token;
  $("#s-gh-sa").value = gh.config.serviceAccount;
  $("#s-gh-repo").addEventListener("change", (e) => { gh.config.repo = e.target.value; });
  $("#s-gh-ref").addEventListener("change", (e) => { gh.config.ref = e.target.value; });
  $("#s-gh-token").addEventListener("change", (e) => { gh.config.token = e.target.value; if (S.file) refreshEstimate(); });
  $("#s-gh-sa").addEventListener("change", (e) => { gh.config.serviceAccount = e.target.value; });
  $("#btn-gh-check").addEventListener("click", async () => {
    const note = $("#gh-check-note");
    note.textContent = "בודק…";
    try {
      const r = await gh.checkAccess();
      note.textContent = `✓ ${r.repo}${r.private ? " (פרטי)" : ""} · workflow ${r.workflowFound ? `נמצא (${r.workflowState})` : "לא נמצא — יש למזג את transcribe.yml לענף"}`;
    } catch (e) { note.textContent = `✗ ${e.message}`; }
  });

  $("#s-segment").value = settings.segmentSec;
  $("#s-segment").addEventListener("change", (e) => store.set("s.segment", clamp(+e.target.value || 600, 60, 1800)));
  $("#s-wakelock").checked = settings.wakeLock;
  $("#s-wakelock").addEventListener("change", (e) => { store.set("s.wakelock", e.target.checked); if (S.file) refreshEstimate(); });
  $("#s-resume").checked = settings.resume;
  $("#s-resume").addEventListener("change", (e) => store.set("s.resume", e.target.checked));

  renderCalibNote();
  $("#btn-reset-calib").addEventListener("click", () => { resetCalibration(); renderCalibNote(); if (S.file) refreshEstimate(); });
  $("#btn-clear-model").addEventListener("click", async () => {
    await clearModelCache();
    LocalRun.clearResume();
    S.model = null;
    if (S.file) refreshEstimate();
    $("#s-model-note").textContent = "המטמון נוקה";
  });
}

function renderCalibNote() {
  const c = loadCalibration();
  const rows = Object.entries(c.routes || {}).map(([k, v]) =>
    `${ROUTE_LABELS[k]}: ${v.runs} ריצות${v.fails ? ` (${v.fails} כשלונות)` : ""}${v.rtf ? `, מהירות ×${v.rtf.value.toFixed(2)}` : ""}`);
  $("#s-calib").textContent = rows.length ? rows.join(" · ") : "עדיין אין ריצות מכוילות במכשיר הזה.";
}

init();
