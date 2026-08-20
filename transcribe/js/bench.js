// Measures how fast *this* phone actually computes, so the time estimate is
// anchored to hardware rather than to a guess about the model name.
//
// Two numbers come out:
//   gpuGflops  — sustained fused-multiply-add throughput through WebGPU
//   cpuGflops  — the same for a JS/typed-array kernel (proxy for the WASM path)
//
// Both are relative measures. They are only ever used as a ratio against the
// reference device in estimator.js, so systematic error mostly cancels out.

import { store } from "./util.js";

const WGSL = /* wgsl */ `
struct Params { iters: u32, a: f32, b: f32, _pad: u32 };
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read_write> out: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  // Four independent accumulators keep the FMA pipeline busy instead of
  // serialising on a single dependency chain.
  var x = vec4<f32>(p.a + f32(gid.x), p.b, p.a, p.b + 1.0);
  var y = vec4<f32>(p.b, p.a, p.b, p.a);
  let ka = vec4<f32>(p.a);
  let kb = vec4<f32>(p.b);
  for (var i: u32 = 0u; i < p.iters; i = i + 1u) {
    x = fma(x, ka, kb);
    y = fma(y, kb, ka);
    x = fma(x, kb, y);
    y = fma(y, ka, x);
  }
  // Consuming the result stops the compiler from deleting the loop.
  out[gid.x] = x.x + x.y + x.z + x.w + y.x + y.y + y.z + y.w;
}`;

/**
 * @param {GPUAdapter|null} adapter reuse the adapter from probeDevice()
 * @returns {Promise<{gflops:number|null, ms:number|null, error:string|null}>}
 */
export async function benchGPU(adapter) {
  if (!adapter && navigator.gpu) adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { gflops: null, ms: null, error: "no-adapter" };
  let device;
  try {
    device = await adapter.requestDevice();
    const module = device.createShaderModule({ code: WGSL });
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });

    const threads = 64 * 512;                    // 32,768 invocations
    const out = device.createBuffer({ size: threads * 4, usage: GPUBufferUsage.STORAGE });
    const uni = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uni } }, { binding: 1, resource: { buffer: out } }],
    });

    const run = async (iters) => {
      const u = new ArrayBuffer(16);
      new Uint32Array(u, 0, 1)[0] = iters;
      new Float32Array(u, 4, 2).set([1.0000001, 0.9999999]);
      device.queue.writeBuffer(uni, 0, u);
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(threads / 64);
      pass.end();
      const t0 = performance.now();
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
      return performance.now() - t0;
    };

    await run(64);                                // warm-up: shader compile + clocks
    const small = await run(256);
    const big = await run(2048);
    // Differencing cancels the fixed submit/sync overhead, which on mobile can
    // be several milliseconds and would otherwise dominate a short kernel.
    const ms = Math.max(0.05, big - small);
    const flops = threads * (2048 - 256) * 4 * 4 * 2;   // 4 FMAs × vec4 × 2 flops
    return { gflops: flops / (ms / 1000) / 1e9, ms: big, error: null };
  } catch (e) {
    return { gflops: null, ms: null, error: String(e?.message || e) };
  } finally {
    try { device?.destroy?.(); } catch { /* ignore */ }
  }
}

/** Blocking ~120 ms f32 matmul. Run it off the main thread when you can. */
export function benchCPU(sizeN = 96) {
  const n = sizeN, A = new Float32Array(n * n), B = new Float32Array(n * n), C = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) { A[i] = (i % 17) * 0.031 + 0.5; B[i] = (i % 13) * 0.047 + 0.5; }
  const mm = () => {
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < n; k++) {
        const a = A[i * n + k]; const kb = k * n; const ic = i * n;
        for (let j = 0; j < n; j++) C[ic + j] += a * B[kb + j];
      }
    }
  };
  mm();                                            // warm the JIT
  const t0 = performance.now();
  let reps = 0;
  while (performance.now() - t0 < 120) { mm(); reps++; }
  const ms = performance.now() - t0;
  const gflops = (reps * 2 * n ** 3) / (ms / 1000) / 1e9;
  return { gflops, reps, checksum: C[0] };
}

const CACHE_KEY = "bench.v1";

/**
 * Benchmarks are cached per device signature — re-running them on every page
 * load would itself heat the phone up.
 */
export async function getBenchmark({ adapter = null, force = false } = {}) {
  const sig = [navigator.hardwareConcurrency, navigator.deviceMemory, navigator.userAgent].join("|");
  const cached = store.get(CACHE_KEY);
  if (!force && cached && cached.sig === sig && Date.now() - cached.at < 30 * 864e5) {
    return { ...cached, cached: true };
  }
  const cpu = benchCPU();
  const gpu = await benchGPU(adapter);
  const result = {
    sig, at: Date.now(),
    cpuGflops: cpu.gflops,
    gpuGflops: gpu.gflops,
    gpuError: gpu.error,
    cached: false,
  };
  store.set(CACHE_KEY, result);
  return result;
}
