/* Luma service worker — app-shell caching + web push notifications. */
const VERSION = "luma-v2";
const PRECACHE = ["/", "/index.html", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(PRECACHE).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Never cache Supabase API / websocket / storage traffic.
  if (url.hostname.endsWith("supabase.co") || url.hostname.endsWith("supabase.in")) return;

  // Navigation requests: network first, fall back to the cached shell offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          caches.open(VERSION).then((c) => c.put("/index.html", res.clone()));
          return res;
        })
        .catch(() => caches.match("/index.html").then((r) => r || Response.error()))
    );
    return;
  }

  // Static assets: cache first, then network.
  if (["script", "style", "image", "font"].includes(req.destination)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok && url.origin === self.location.origin) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
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
