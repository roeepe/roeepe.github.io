// Resolves what the on-device route will actually have to download, by asking
// the Hugging Face Hub for the real file sizes instead of guessing them, and by
// checking what is already sitting in the browser's cache.

const HF = "https://huggingface.co";
const TRANSFORMERS_CACHE = "transformers-cache";

// dtype suffixes transformers.js appends to an ONNX file name, cheapest first.
const DTYPES = [
  { id: "q4",       suffix: "_q4",        label: "q4 — הכי קטן ומהיר",       quality: 0.93 },
  { id: "q4f16",    suffix: "_q4f16",     label: "q4f16 — קטן, איכות טובה",   quality: 0.95 },
  { id: "int8",     suffix: "_int8",      label: "int8",                      quality: 0.94 },
  { id: "quantized",suffix: "_quantized", label: "quantized (q8)",            quality: 0.96 },
  { id: "uint8",    suffix: "_uint8",     label: "uint8",                     quality: 0.94 },
  { id: "fp16",     suffix: "_fp16",      label: "fp16 — איכות מלאה, כבד",    quality: 1.00 },
  { id: "fp32",     suffix: "",           label: "fp32 — מלא, הכי כבד",       quality: 1.00 },
];

export const CATALOG = [
  {
    id: "instush/ivrit-whisper-large-v3-turbo-timestamped-onnx",
    name: "ivrit-ai large-v3-turbo (ONNX, עם חותמות זמן)",
    note: "הפיינטיון העברי של ivrit-ai, מומר ל-ONNX כדי לרוץ בדפדפן. ברירת המחדל.",
    language: "he", hebrew: true,
  },
  {
    id: "onnx-community/whisper-large-v3-turbo",
    name: "whisper-large-v3-turbo (רב-לשוני, לא מכוון לעברית)",
    note: "גיבוי אם המודל של ivrit-ai לא נטען. איכות נמוכה יותר בעברית.",
    language: "he", hebrew: false,
  },
  {
    id: "onnx-community/whisper-base",
    name: "whisper-base (זעיר — לבדיקה בלבד)",
    note: "‎~150 MB. שימושי כדי לוודא שהצינור עובד לפני הורדה של גיגה וחצי.",
    language: "he", hebrew: false,
  },
];

const fileUrl = (repo, path, rev = "main") => `${HF}/${repo}/resolve/${rev}/${path}`;

async function listTree(repo, path, rev = "main") {
  const url = `${HF}/api/models/${repo}/tree/${rev}${path ? "/" + path : ""}`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`HF ${r.status} עבור ${repo}/${path || "(שורש)"}`);
  return r.json();
}

const sizeOf = (entry) => entry?.lfs?.size ?? entry?.size ?? 0;

/**
 * Reads the repo's onnx/ folder and returns one option per dtype that actually
 * exists there, with the exact byte total the phone would have to fetch.
 */
export async function resolveModel(repoId, { revision = "main" } = {}) {
  const [onnxTree, rootTree] = await Promise.all([
    listTree(repoId, "onnx", revision),
    listTree(repoId, "", revision).catch(() => []),
  ]);

  const byName = new Map();
  for (const e of onnxTree) {
    if (e.type !== "file" || !e.path.endsWith(".onnx")) continue;
    byName.set(e.path.split("/").pop(), sizeOf(e));
  }
  // External-data files (.onnx_data) sit next to big models and count too.
  const externalData = new Map();
  for (const e of onnxTree) {
    if (e.type === "file" && e.path.endsWith(".onnx_data")) externalData.set(e.path.split("/").pop(), sizeOf(e));
  }

  const configBytes = rootTree
    .filter((e) => e.type === "file" && /\.(json|txt)$/.test(e.path))
    .reduce((s, e) => s + sizeOf(e), 0);

  const components = ["encoder_model", "decoder_model_merged"];
  const options = [];
  for (const dt of DTYPES) {
    const parts = components.map((c) => {
      const fn = `${c}${dt.suffix}.onnx`;
      if (!byName.has(fn)) return null;
      return { file: fn, bytes: byName.get(fn) + (externalData.get(fn + "_data") || 0) };
    });
    if (parts.some((p) => !p)) continue;
    options.push({
      ...dt,
      files: parts.map((p) => p.file),
      bytes: parts.reduce((s, p) => s + p.bytes, 0) + configBytes,
      urls: [
        ...parts.map((p) => fileUrl(repoId, `onnx/${p.file}`, revision)),
        ...rootTree.filter((e) => e.type === "file" && /\.json$/.test(e.path)).map((e) => fileUrl(repoId, e.path, revision)),
      ],
    });
  }
  if (!options.length) throw new Error(`לא נמצאו קבצי ONNX ב-${repoId}`);
  return { repoId, revision, configBytes, options };
}

/** Which dtype suits this device: fit the memory budget, then take the best quality that fits. */
export function pickDtype(resolved, { budgetBytes, preferSmall = false }) {
  const usable = resolved.options.filter((o) => o.bytes * 1.3 < budgetBytes);
  const pool = usable.length ? usable : [resolved.options.slice().sort((a, b) => a.bytes - b.bytes)[0]];
  if (preferSmall) return pool.slice().sort((a, b) => a.bytes - b.bytes)[0];
  return pool.slice().sort((a, b) => b.quality - a.quality || a.bytes - b.bytes)[0];
}

/**
 * How much of this option is already cached — the difference between a 20-minute
 * first run and a 4-minute second one, so the estimate has to know.
 */
export async function cacheState(option) {
  if (!self.caches) return { cached: false, cachedBytes: 0, ratio: 0, supported: false };
  try {
    const cache = await caches.open(TRANSFORMERS_CACHE);
    let hits = 0;
    for (const url of option.urls) if (await cache.match(url)) hits++;
    const ratio = option.urls.length ? hits / option.urls.length : 0;
    return { cached: ratio > 0.95, cachedBytes: option.bytes * ratio, ratio, supported: true };
  } catch {
    return { cached: false, cachedBytes: 0, ratio: 0, supported: false };
  }
}

export async function clearModelCache() {
  if (!self.caches) return false;
  return caches.delete(TRANSFORMERS_CACHE);
}

export { DTYPES, TRANSFORMERS_CACHE, fileUrl };
