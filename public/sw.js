/* Luma service worker — app-shell caching + web push notifications. */
const VERSION = "luma-v3-offline";
const PRECACHE = ["/", "/index.html", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

// The first page's scripts are normally requested before a newly installed SW
// controls the page. Discover and cache the hashed Vite bundle during install,
// otherwise a first offline reload has an HTML shell but no JavaScript.
async function precacheShell() {
  const cache = await caches.open(VERSION);
  const response = await fetch("/index.html", { cache: "reload" });
  if (!response.ok) throw new Error("App shell unavailable");
  const html = await response.clone().text();
  await cache.put("/index.html", response);
  const assets = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map((m) => m[1]);
  await Promise.all([...new Set([...PRECACHE.filter((url) => url !== "/index.html"), ...assets])].map(async (url) => {
    try {
      const res = await fetch(url, { cache: "reload" });
      if (!res.ok) return;
      if (url.endsWith(".css")) {
        const css = await res.clone().text();
        const fonts = [...css.matchAll(/url\(["']?(\/assets\/[^)"']+)["']?\)/g)].map((m) => m[1]);
        await Promise.all(fonts.map(async (font) => { try { const f = await fetch(font); if (f.ok) await cache.put(font, f); } catch {} }));
      }
      await cache.put(url, res);
    } catch { /* optional icons/fonts must not break the shell */ }
  }));
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("luma-") && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Never cache authenticated Supabase responses, media URLs, or third-party data.
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); event.waitUntil(caches.open(VERSION).then((c) => c.put("/index.html", copy))); }
      return res;
    }).catch(() => caches.match("/index.html").then((r) => r || Response.error())));
    return;
  }
  if (["script", "style", "image", "font"].includes(req.destination)) {
    event.respondWith(caches.match(req, { ignoreVary: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); event.waitUntil(caches.open(VERSION).then((c) => c.put(req, copy))); }
      return res;
    })));
  }
});

/* ------------------------------- push ---------------------------------- */
self.addEventListener("push", (event) => {
  let data = { title: "Luma", body: "New activity in your conversations.", url: "/" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    try {
      data.body = event.data.text();
    } catch {
      /* keep defaults */
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.tag || "luma-message",
      data: { url: data.url || "/" },
      renotify: true,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((wins) => {
        for (const win of wins) {
          if ("focus" in win) {
            win.navigate(target);
            return win.focus();
          }
        }
        return clients.openWindow(target);
      })
  );
});
