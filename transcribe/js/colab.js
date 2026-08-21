// The Colab route.
//
// Two ways in, same transcription code at the far end:
//   • from the phone — a copy of notebooks/ivrit_transcribe.ipynb is written to
//     Drive with this job's file ids baked into its parameters cell, and opened
//     in Colab. Tap "Run all" and put the phone down.
//   • from a computer — tools/colab_job.sh drives the official `colab` CLI
//     (colab new → upload → exec → download) with no browser at all.

import * as drive from "./google.js";
import { store } from "./util.js";

const NOTEBOOK_TEMPLATE = new URL("../../notebooks/ivrit_transcribe.ipynb", import.meta.url).href;
const PARAMS_MARKER = "# --- ivrit-job-params ---";
export const DEFAULT_CT2_MODEL = "ivrit-ai/whisper-large-v3-turbo-ct2";

export const CT2_MODELS = [
  { id: "ivrit-ai/whisper-large-v3-turbo-ct2", label: "ivrit-ai turbo (מומלץ — מהיר ומדויק)" },
  { id: "ivrit-ai/whisper-large-v3-ct2", label: "ivrit-ai large-v3 (איטי יותר, לפעמים מדויק יותר)" },
  { id: "ivrit-ai/yi-whisper-large-v3-ct2", label: "ivrit-ai yi-large-v3" },
];

function paramsCell(job) {
  return [
    PARAMS_MARKER,
    "# נוצר אוטומטית על ידי האפליקציה בנייד.",
    "JOB = {",
    `    "input": ${JSON.stringify("drive:" + job.audioFileId)},`,
    `    "output": ${JSON.stringify("drive:" + job.resultFileId)},`,
    `    "model": ${JSON.stringify(job.model || DEFAULT_CT2_MODEL)},`,
    `    "language": ${JSON.stringify(job.language || "he")},`,
    `    "beam_size": ${job.beamSize ?? 5},`,
    "}",
    "",
  ].join("\n");
}

/** Fetches the checked-in notebook and swaps its parameters cell for this job's. */
export async function buildNotebook(job) {
  const r = await fetch(NOTEBOOK_TEMPLATE, { cache: "no-cache" });
  if (!r.ok) throw new Error(`לא הצלחתי לטעון את תבנית המחברת (${r.status})`);
  const nb = await r.json();
  const idx = nb.cells.findIndex((c) => (Array.isArray(c.source) ? c.source.join("") : c.source).includes(PARAMS_MARKER));
  if (idx < 0) throw new Error("תבנית המחברת לא מכילה תא פרמטרים");
  nb.cells[idx] = { ...nb.cells[idx], source: paramsCell(job).split("\n").map((l, i, a) => (i < a.length - 1 ? l + "\n" : l)) };
  return nb;
}

/**
 * Uploads the recording, creates the result placeholder the phone will poll,
 * and puts a job-specific notebook next to them in Drive.
 */
export async function createJob(file, { model, language = "he", beamSize = 5, onProgress = () => {}, signal } = {}) {
  onProgress({ stage: "auth", label: "מתחבר ל-Google Drive" });
  await drive.signIn();
  const folderId = await drive.ensureFolder();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "recording";

  onProgress({ stage: "upload", label: "מעלה את ההקלטה ל-Drive", ratio: 0 });
  const audio = await drive.uploadFile(file, {
    name: `${stamp}__${file.name}`, parents: [folderId], signal,
    onProgress: (p) => onProgress({ stage: "upload", label: "מעלה את ההקלטה ל-Drive", ...p }),
  });

  onProgress({ stage: "prepare", label: "מכין את קובץ התוצאה" });
  const result = await drive.createFile({
    name: `${stamp}__${base}.result.json`, parents: [folderId],
    content: JSON.stringify({ status: "queued", createdAt: Date.now(), source: file.name }, null, 1),
  });

  const job = { audioFileId: audio.id, resultFileId: result.id, model: model || DEFAULT_CT2_MODEL, language, beamSize };

  onProgress({ stage: "notebook", label: "יוצר מחברת Colab לעבודה הזאת" });
  const nb = await buildNotebook(job);
  const notebook = await drive.createFile({
    name: `${stamp}__${base}.ipynb`, parents: [folderId],
    mimeType: "application/json", content: JSON.stringify(nb),
  });

  const record = {
    ...job, folderId, notebookId: notebook.id, audioName: file.name, bytes: file.size,
    colabUrl: colabUrl(notebook.id), createdAt: Date.now(),
  };
  const jobs = store.get("colab.jobs", []);
  store.set("colab.jobs", [record, ...jobs].slice(0, 20));
  onProgress({ stage: "ready", label: "מוכן", job: record });
  return record;
}

export const colabUrl = (notebookFileId) => `https://colab.research.google.com/drive/${notebookFileId}`;

/** The exact command line for the desktop route, ready to copy. */
export function cliSnippet(job) {
  return [
    "# פעם אחת:",
    "pip install google-colab-cli",
    "",
    "# על הקובץ שכבר ב-Drive:",
    `tools/colab_job.sh -g T4 -m ${job?.model || DEFAULT_CT2_MODEL} -d ${job?.audioFileId || "<DRIVE_FILE_ID>"}`,
    "",
    "# או ישירות על קובץ מקומי:",
    "tools/colab_job.sh -g T4 ~/Downloads/shiur.m4a",
  ].join("\n");
}

export const recentJobs = () => store.get("colab.jobs", []);
