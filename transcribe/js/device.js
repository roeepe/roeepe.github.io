// Probes what this particular phone can actually offer. Everything here is a
// measurement or a browser-reported fact — never an assumption. Fields that the
// browser refuses to expose come back `null`, and the estimator widens its
// uncertainty accordingly instead of inventing a value.

const nav = typeof navigator !== "undefined" ? navigator : {};

export async function probeDevice() {
  const d = {
    ua: nav.userAgent || "",
    mobile: !!(nav.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod/i.test(nav.userAgent || "")),
    platform: nav.userAgentData?.platform || nav.platform || "",
    cores: nav.hardwareConcurrency || null,
    // Chrome buckets and caps this at 8 GB, so treat it as a lower bound.
    memoryGB: nav.deviceMemory || null,
    memoryIsCapped: nav.deviceMemory === 8,
    jsHeapLimitBytes: performance?.memory?.jsHeapSizeLimit || null,
    screen: { w: screen?.width, h: screen?.height, dpr: devicePixelRatio || 1 },
    storage: { quotaBytes: null, usageBytes: null, persisted: null },
    network: { effectiveType: null, downlinkMbps: null, uplinkMbps: null, rtt: null, saveData: false, type: null },
    battery: { level: null, charging: null, supported: false },
    gpu: { webgpu: false, adapter: null, limits: null, features: [], fallback: null, error: null },
    wasm: { simd: false, threads: false },
    wakeLock: "wakeLock" in nav,
    crossOriginIsolated: typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : false,
    storageManager: !!nav.storage?.estimate,
  };

  try {
    const est = await nav.storage?.estimate?.();
    if (est) { d.storage.quotaBytes = est.quota ?? null; d.storage.usageBytes = est.usage ?? null; }
    d.storage.persisted = (await nav.storage?.persisted?.()) ?? null;
  } catch { /* not exposed */ }

  const c = nav.connection || nav.mozConnection || nav.webkitConnection;
  if (c) {
    d.network.effectiveType = c.effectiveType ?? null;
    d.network.downlinkMbps = c.downlink ?? null;
    d.network.rtt = c.rtt ?? null;
    d.network.saveData = !!c.saveData;
    d.network.type = c.type ?? null;
  }
  // Uplink is never reported. Mobile uplink is typically a fraction of downlink;
  // this ratio is a prior, and only ever used for upload-time estimates.
  if (d.network.downlinkMbps) d.network.uplinkMbps = d.network.downlinkMbps * 0.35;

  try {
    const b = await nav.getBattery?.();
    if (b) { d.battery = { level: b.level, charging: b.charging, supported: true }; d._batteryRef = b; }
  } catch { /* Safari / Firefox */ }

  d.wasm.simd = await wasmFeature([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);
  d.wasm.threads = typeof SharedArrayBuffer !== "undefined";

  Object.assign(d.gpu, await probeGPU());
  return d;
}

async function wasmFeature(bytes) {
  try { return WebAssembly.validate(new Uint8Array(bytes)); } catch { return false; }
}

async function probeGPU() {
  if (!nav.gpu) return { webgpu: false, error: "אין תמיכה ב-WebGPU בדפדפן הזה" };
  try {
    const adapter = await nav.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return { webgpu: false, error: "הדפדפן תומך ב-WebGPU אבל לא הוקצה מתאם גרפי" };
    const info = adapter.info || (await adapter.requestAdapterInfo?.()) || {};
    const L = adapter.limits || {};
    return {
      webgpu: true,
      adapter: {
        vendor: info.vendor || "", architecture: info.architecture || "",
        device: info.device || "", description: info.description || "",
      },
      limits: {
        maxBufferSize: L.maxBufferSize ?? null,
        maxStorageBufferBindingSize: L.maxStorageBufferBindingSize ?? null,
        maxComputeWorkgroupStorageSize: L.maxComputeWorkgroupStorageSize ?? null,
        maxComputeInvocationsPerWorkgroup: L.maxComputeInvocationsPerWorkgroup ?? null,
      },
      features: Array.from(adapter.features || []),
      fallback: adapter.isFallbackAdapter ?? null,
      _adapter: adapter,
    };
  } catch (e) {
    return { webgpu: false, error: String(e?.message || e) };
  }
}

/** Human-readable one-liner for the device card. */
export function describeDevice(d) {
  const bits = [];
  bits.push(d.mobile ? "נייד" : "מחשב");
  if (d.cores) bits.push(`${d.cores} ליבות`);
  if (d.memoryGB) bits.push(`${d.memoryGB}${d.memoryIsCapped ? "+" : ""} GB RAM`);
  bits.push(d.gpu.webgpu ? "WebGPU ✓" : "בלי WebGPU");
  if (d.network.effectiveType) bits.push(d.network.effectiveType);
  return bits.join(" · ");
}

/** Bytes we can plausibly hand to a model before the tab gets killed. */
export function memoryBudgetBytes(d) {
  // A browser tab on a phone rarely survives past ~55% of physical RAM, and the
  // OS + browser chrome are already holding a chunk of it.
  const gb = d.memoryGB || (d.mobile ? 3 : 8);
  const share = d.mobile ? 0.5 : 0.65;
  return gb * 1024 ** 3 * share;
}
