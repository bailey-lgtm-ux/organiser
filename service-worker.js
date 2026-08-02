/* Service worker: caches the app shell so the organiser works offline
 * and can be installed as an app. Bump CACHE_VERSION when files change.
 *
 * Strategy is stale-while-revalidate: you get the cached copy instantly,
 * and a fresh copy is fetched in the background for next time. That matters
 * now the app is hosted — a plain cache-first worker would keep serving old
 * code long after you'd published an update.
 */

const CACHE_VERSION = "vce-organiser-v5";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./quickadd.js",
  "./app.js",
  "./sync.js",
  "./firebase-config.js",
  "./icon.svg",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  /* Leave everything else alone — Firebase sign-in and Firestore traffic must
     reach the network untouched, and must never be answered with cached HTML. */
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const cached = await cache.match(req);

      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            cache.put(req, res.clone());
          }
          return res;
        })
        .catch(() => null);

      if (cached) return cached;                  // instant, refreshed above
      const fresh = await network;
      if (fresh) return fresh;

      // Offline and never cached: fall back to the app shell for page loads.
      if (req.mode === "navigate") {
        const shell = await cache.match("./index.html");
        if (shell) return shell;
      }
      return Response.error();
    })
  );
});
