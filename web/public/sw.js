/* Atrium PWA service worker：缓存应用外壳，让"独立应用"在太和服务没开时也能打开并给出提示；
 * 在线一律走网络取新（避免旧 bundle 白屏），仅断网时回退缓存。API 请求不拦。 */
const SHELL_CACHE = "atrium-shell-v3";
const ASSET_CACHE = "atrium-assets-v3";
const SHELL_URLS = ["/", "/index.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-maskable.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const c = await caches.open(SHELL_CACHE);
      await Promise.all(
        SHELL_URLS.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {}))
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域（字体等）不拦，离线时自然降级
  if (url.pathname.startsWith("/api/")) return;    // 接口始终走网络

  // 页面导航：网络优先，服务没开时回退到缓存的应用外壳（保证能打开）
  if (req.mode === "navigate") {
    e.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res && res.ok) {
            const c = await caches.open(SHELL_CACHE);
            c.put("/index.html", res.clone()).catch(() => {});
            c.put("/", res.clone()).catch(() => {});
          }
          return res;
        } catch {
          const c = await caches.open(SHELL_CACHE);
          return (await c.match("/index.html")) || (await c.match("/")) || Response.error();
        }
      })()
    );
    return;
  }

  // 静态资源：/assets 里的哈希文件缓存优先（内容不可变）；其它 stale-while-revalidate
  const immutable = url.pathname.startsWith("/assets/");
  e.respondWith(
    (async () => {
      const c = await caches.open(immutable ? ASSET_CACHE : SHELL_CACHE);
      const cached = await c.match(req);
      if (immutable && cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.ok && (res.type === "basic" || res.type === "default")) c.put(req, res.clone()).catch(() => {});
        return res;
      } catch (err) {
        if (cached) return cached;
        throw err;
      }
    })()
  );
});