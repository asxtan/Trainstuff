// Service worker: keep the installed app fresh while still working offline.
// Strategy: network-first for our own app shell (so a new deploy shows up
// immediately), falling back to cache when offline. Live train data (the
// cross-origin Huxley2 API) is never handled here — it always hits the network.
var CACHE = "commute-board-v4";
var SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./stations.json",
  "./sample_board.json",
  "./icon-192.png?v=2",
  "./icon-512.png?v=2",
  "./apple-touch-icon.png?v=2"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  // Only handle same-origin GETs (our app shell). The cross-origin train API
  // and everything else go straight to the network, uncached.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req); // offline → serve last cached copy
    })
  );
});
