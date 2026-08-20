// Caches the app shell so the PWA opens without a network, and stays out of the
// way of everything else. In particular it never touches the Hugging Face model
// files — transformers.js keeps those in its own Cache Storage entry, and
// double-caching a 1.6 GB model would blow the storage quota.

const SHELL = "ivrit-shell-v1";
const ASSETS = [
  "./", "./index.html", "./styles.css", "./manifest.webmanifest", "./icon.svg",
  "./js/main.js", "./js/util.js", "./js/device.js", "./js/bench.js", "./js/audio.js",
  "./js/estimator.js", "./js/calibration.js", "./js/models.js", "./js/local-run.js",
  "./js/worker.js", "./js/monitor.js", "./js/formats.js", "./js/google.js",
  "./js/colab.js", "./js/ghactions.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("ivrit-shell-") && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;      // HF, Google, GitHub, CDN: always live
  if (!url.pathname.includes("/transcribe/")) return;

  // Network-first so a deploy is picked up immediately, cache as the fallback.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("./index.html")))
  );
});
