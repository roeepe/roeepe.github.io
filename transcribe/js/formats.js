// Export formats. Hebrew text is stored as-is; RTL is a rendering concern, and
// injecting direction marks would corrupt the text for downstream tools.

import { fmtTimestamp } from "./util.js";

export function toText(chunks, { paragraphGapSec = 2.2 } = {}) {
  if (!chunks?.length) return "";
  const out = [];
  let para = [];
  let prevEnd = null;
  for (const c of chunks) {
    if (prevEnd != null && c.start - prevEnd > paragraphGapSec && para.length) { out.push(para.join(" ")); para = []; }
    para.push(c.text.trim());
    prevEnd = c.end;
  }
  if (para.length) out.push(para.join(" "));
  return out.join("\n\n");
}

export function toSRT(chunks) {
  return chunks.map((c, i) =>
    `${i + 1}\n${fmtTimestamp(c.start)} --> ${fmtTimestamp(c.end || c.start + 2)}\n${c.text.trim()}\n`
  ).join("\n");
}

export function toVTT(chunks) {
  return "WEBVTT\n\n" + chunks.map((c) =>
    `${fmtTimestamp(c.start, false)} --> ${fmtTimestamp(c.end || c.start + 2, false)}\n${c.text.trim()}\n`
  ).join("\n");
}

export function toJSON(result) {
  return JSON.stringify({
    model: result.model, backend: result.backend, language: result.language || "he",
    audioSeconds: result.audioSeconds, generatedAt: new Date().toISOString(),
    text: result.text, segments: result.chunks,
  }, null, 2);
}

export const EXPORTS = [
  { id: "txt",  label: "טקסט",  ext: "txt",  mime: "text/plain;charset=utf-8",       build: (r) => toText(r.chunks) || r.text },
  { id: "srt",  label: "SRT",   ext: "srt",  mime: "application/x-subrip;charset=utf-8", build: (r) => toSRT(r.chunks) },
  { id: "vtt",  label: "VTT",   ext: "vtt",  mime: "text/vtt;charset=utf-8",         build: (r) => toVTT(r.chunks) },
  { id: "json", label: "JSON",  ext: "json", mime: "application/json;charset=utf-8", build: toJSON },
];
