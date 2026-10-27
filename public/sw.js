// DisciplineFeed service worker: offline reading.
//
// Network-first everywhere. Online, every request goes to the network and the caches are only
// refreshed, so a deploy is picked up immediately and a stale app is never served; the caches answer
// only when the network fails (or, for API data, stalls). App code never falls back on a timeout,
// only on failure, so a slow connection can't pair old JavaScript with a new page.

const VERSION = "v1";
const SHELL_CACHE = `df-shell-${VERSION}`;
const DATA_CACHE = `df-data-${VERSION}`;
const FONT_CACHE = `df-fonts-${VERSION}`;
const SHELL_FILES = ["/", "/app.js", "/style.css", "/prefs.js", "/manifest.webmanifest", "/favicon.svg", "/icons/icon-192.png"];
const DATA_TIMEOUT_MS = 4000;
const MAX_CACHED_ARTICLES = 300;
const ARTICLE_PATH = /^\/api\/articles\/\d+$/;
// Read-only API responses worth keeping for offline use. Paged and searched lists are left out.
const CACHED_API_PATHS = ["/api/feeds", "/api/highlights", "/api/scripts", "/api/stats/reading", "/api/topics", "/api/discover"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(SHELL_FILES.map((url) => new Request(url, { cache: "reload" })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const current = new Set([SHELL_CACHE, DATA_CACHE, FONT_CACHE]);
      for (const name of await caches.keys()) {
        if (name.startsWith("df-") && !current.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (request.mode === "navigate") {
      event.respondWith(networkFirst(event, request, SHELL_CACHE, `${url.origin}/`, { timeoutMs: 0 }));
    } else if (url.pathname.startsWith("/api/")) {
      if (isCachedApi(url)) {
        event.respondWith(networkFirst(event, request, DATA_CACHE, apiCacheKey(url), { timeoutMs: DATA_TIMEOUT_MS }));
      }
    } else if (SHELL_FILES.includes(url.pathname) || url.pathname.startsWith("/icons/")) {
      event.respondWith(networkFirst(event, request, SHELL_CACHE, url.href, { timeoutMs: 0 }));
    }
    return;
  }

  // Google Fonts: the font files are immutable, the stylesheet that lists them is not.
  if (url.hostname === "fonts.gstatic.com") event.respondWith(cacheFirst(request, FONT_CACHE));
  else if (url.hostname === "fonts.googleapis.com") {
    event.respondWith(networkFirst(event, request, FONT_CACHE, url.href, { timeoutMs: DATA_TIMEOUT_MS }));
  }
});

function isCachedApi(url) {
  if (ARTICLE_PATH.test(url.pathname)) return true;
  if (url.pathname === "/api/articles") return !url.searchParams.has("cursor") && !url.searchParams.has("q");
  return CACHED_API_PATHS.includes(url.pathname);
}

// An article is cached by its path alone: opening it (?day=, for the streak) and pre-caching it
// (?peek=1) fetch the same thing. Other keys drop an empty "?" so "/api/articles?" and
// "/api/articles" share an entry.
function apiCacheKey(url) {
  return ARTICLE_PATH.test(url.pathname) ? `${url.origin}${url.pathname}` : `${url.origin}${url.pathname}${url.search}`;
}

function networkFirst(event, request, cacheName, key, { timeoutMs }) {
  const network = fetch(request).then(async (response) => {
    if (response.ok) {
      try {
        const cache = await caches.open(cacheName);
        await cache.put(key, response.clone());
        if (cacheName === DATA_CACHE && ARTICLE_PATH.test(new URL(key).pathname)) await trimArticles(cache);
      } catch {
        // Out of quota or similar: still return the live response.
      }
    }
    return response;
  });
  // Let a slow response finish updating the cache even after a cached copy was served.
  event.waitUntil(network.catch(() => {}));

  return (async () => {
    const cached = await caches.match(key, { cacheName, ignoreVary: true });
    if (!cached) return network;
    try {
      const response = await withTimeout(network, timeoutMs);
      if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch {
      return markedAsCached(cached);
    }
  })();
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone()).catch(() => {});
  return response;
}

function withTimeout(promise, ms) {
  if (!ms) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

// Tells the page this came from the offline cache, so it can say so.
function markedAsCached(response) {
  const headers = new Headers(response.headers);
  headers.set("x-offline-cache", "1");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Keeps the newest articles. Cache keys list in insertion order and re-caching an article moves it
// to the end, so the oldest-touched go first.
async function trimArticles(cache) {
  const articles = (await cache.keys()).filter((req) => ARTICLE_PATH.test(new URL(req.url).pathname));
  const excess = articles.length - MAX_CACHED_ARTICLES;
  for (let i = 0; i < excess; i++) await cache.delete(articles[i]);
}
