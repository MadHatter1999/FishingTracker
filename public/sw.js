// Nova Scotian Anglers Guild - service worker (offline app shell + asset cache).
// Hand-rolled (no Workbox) to keep dependencies minimal.
const CACHE = "nsag-v2";
// Map tiles the user deliberately saved via "Save offline" (populated by the app,
// kept across SW updates). Name must match TILE_CACHE in src/ui/map.ts.
const TILE_CACHE = "nsag-tiles-v1";
const KEEP = [CACHE, TILE_CACHE];
// Cross-origin tile hosts whose saved tiles we serve cache-first when offline.
const TILE_HOSTS = ["tile.openstreetmap.org", "tile.opentopomap.org", "tile.waymarkedtrails.org"];
const SHELL = ["/", "/index.html", "/fishing.png", "/manifest.webmanifest", "/fonts/spinnaker-latin.woff2", "/fonts/spinnaker-latin-ext.woff2"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Saved map tiles: serve cache-first from the offline tile cache when present
  // (so the backcountry map still draws with no signal), otherwise hit the network.
  // Only previously-saved tiles are in the cache; we don't auto-cache while browsing.
  if (TILE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith("." + h))) {
    event.respondWith(
      caches.open(TILE_CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req)))
    );
    return;
  }

  // Never touch the API, the websocket, or other cross-origin requests (live tides,
  // weather, OCEARCH, live tiles all go straight to the network).
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  // App navigations: network-first, fall back to the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/index.html", copy));
          return res;
        })
        .catch(() => caches.match("/index.html").then((r) => r || caches.match("/")))
    );
    return;
  }

  // Same-origin static assets (hashed JS/CSS, icons): cache-first, then network.
  event.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached)
    )
  );
});
