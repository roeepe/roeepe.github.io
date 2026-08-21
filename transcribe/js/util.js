// Small shared helpers. No dependencies.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Logistic curve, centred on `mid`, reaching ~0.88 at mid+width. */
export const logistic = (x, mid, width) => 1 / (1 + Math.exp(-(x - mid) / (width / 2)));

/** Combine independent hazards into a single probability. */
export const combine = (ps) => 1 - ps.reduce((acc, p) => acc * (1 - clamp(p, 0, 0.995)), 1);

export function fmtBytes(b) {
  if (!isFinite(b) || b <= 0) return "0";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  const v = b / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

/** Duration in Hebrew, e.g. "2 שעות 14 דק׳". */
export function fmtDuration(sec) {
  if (!isFinite(sec) || sec < 0) return "—";
  sec = Math.round(sec);
  if (sec < 60) return `${sec} שנ׳`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return s && m < 10 ? `${m}:${String(s).padStart(2, "0")} דק׳` : `${m} דק׳`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm ? `${h} שע׳ ${rm} דק׳` : `${h} שע׳`;
}

/** SRT/VTT timestamp. */
export function fmtTimestamp(sec, comma = true) {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${comma ? "," : "."}${pad(ms, 3)}`;
}

export const pct = (p) => `${Math.round(clamp(p, 0, 1) * 100)}%`;

export function download(name, text, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** localStorage-backed JSON with a namespace prefix. */
export const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem("ivrit." + key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem("ivrit." + key, JSON.stringify(value)); } catch { /* quota / private mode */ }
  },
  del(key) { try { localStorage.removeItem("ivrit." + key); } catch { /* ignore */ } },
};

/** Exponentially weighted mean that also tracks how many samples it has seen. */
export function ewma(prev, sample, alpha = 0.4) {
  if (!prev || !isFinite(prev.value)) return { value: sample, n: 1 };
  return { value: prev.value * (1 - alpha) + sample * alpha, n: (prev.n || 0) + 1 };
}
