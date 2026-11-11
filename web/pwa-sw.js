// Centinela: la app funciona sin conexión con lo último descargado.
const V = "centinela-__VERSION__";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/apple-touch-icon.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const sameOrigin = u.origin === location.origin;
  const isFont = /fonts\.(googleapis|gstatic)\.com$/.test(u.hostname);
  if (!sameOrigin && !isFont) return;
  if (isFont) {   // fuentes: caché primero
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((res) => { const c = res.clone(); caches.open(V).then((ca) => ca.put(e.request, c)); return res; })));
    return;
  }
  // app y datos: red primero, caché si no hay conexión
  const key = u.pathname.endsWith("data.enc.json") ? new Request(u.origin + u.pathname) : e.request;
  e.respondWith(fetch(e.request).then((res) => { if (res.ok) { const c = res.clone(); caches.open(V).then((ca) => ca.put(key, c)); } return res; })
    .catch(() => caches.match(key, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))));
});
