// Voorpagina service worker: app werkt ook even zonder verbinding
const SHELL = "vp-shell-v1";
const FILES = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icon-192.png", "apple-touch-icon.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL && k !== "vp-data").map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;
  if (url.pathname.endsWith("/data/articles.json")) {
    // eerst netwerk, bij geen verbinding de laatst geladen versie
    e.respondWith(fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open("vp-data").then((c) => c.put(url.pathname, copy));
      return r;
    }).catch(() => caches.open("vp-data").then((c) => c.match(url.pathname))));
    return;
  }
  // app-bestanden: netwerk eerst zodat updates meteen doorkomen, anders cache
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone();
    caches.open(SHELL).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
