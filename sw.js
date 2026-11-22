// Service worker for わたしのレシピ帳
//
// Design rule: no single failure may break offline support.
// Every cache write is attempted individually and swallowed on error, so a
// redirect, a blocked CDN or a missing file can never abort installation the
// way a bulk cache.addAll() would.

// Deliberately unversioned. Versioning the name meant every update wiped the
// cache on activate, leaving the app unable to open offline until it had been
// launched online again. Updates still land: the shell is refreshed in the
// background on every launch, and the CDN libraries are version-pinned.
const CACHE = 'recipe-notebook';

// Everything is keyed off this file's own location rather than a hard-coded
// '/', so the app still works if it is ever deployed under a sub-path.
//
// self.location is used rather than self.registration.scope deliberately.
// Anything that throws while the worker script is being evaluated makes the
// whole registration fail with nothing but "Script load failed", which is
// almost impossible to diagnose from a phone. self.location is defined in
// every engine before any code runs; self.registration is not worth the risk
// for the same result.
const BASE = (function () {
  try {
    return new URL('./', self.location.href).href;
  } catch (e) {
    return '/';
  }
})();

// The app is a single page. Only the directory URL is stored: a request for
// 'index.html' is redirected to the directory on Cloudflare Pages, and caching
// a redirected response throws — which is what silently disabled offline mode
// in an earlier build.
const SHELL_KEY = BASE;

// Same-origin files the app needs in order to start. The manifest and icons
// are included because iOS re-reads them when the web app is launched.
const LOCAL_WARM = [
  BASE,
  BASE + 'manifest.webmanifest',
  BASE + 'icon-192.png',
  BASE + 'apple-touch-icon.png'
];

// Libraries the app needs in order to boot at all. Warmed at install time so
// the very next launch works with no connection.
const LIB_WARM = [
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/tesseract.min.js'
];

const ALL_WARM = LOCAL_WARM.concat(LIB_WARM);

const LIB_HOSTS = [
  'www.gstatic.com',
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

// Live API traffic: never cached, the SDKs handle their own offline behaviour.
const API_HOSTS = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'firebaseio.com',
  'api.groq.com',
  'api.anthropic.com'
];

const matchesHost = (hostname, list) =>
  list.some(h => hostname === h || hostname.endsWith('.' + h));

const isLibHost = h => matchesHost(h, LIB_HOSTS);
const isApiHost = h => matchesHost(h, API_HOSTS);

// Cache one URL, never throwing. Redirects are followed and the final
// response is stored under the requested key.
//
// The fetch is capped: on a weak signal a request can stay pending for a very
// long time, and without a cap one unreachable CDN file holds up installation
// and therefore the whole offline setup. A file that times out here is simply
// retried on the next launch.
const WARM_TIMEOUT_MS = 12000;

async function safeCache(cache, url) {
  let timer = null;
  try {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (ctrl) timer = setTimeout(() => ctrl.abort(), WARM_TIMEOUT_MS);
    const res = await fetch(url, {
      redirect: 'follow',
      cache: 'reload',
      signal: ctrl ? ctrl.signal : undefined
    });
    if (res && (res.ok || res.type === 'opaque')) {
      await cache.put(url, res.clone());
      return true;
    }
  } catch (e) {
    // Intentionally ignored: a failed warm-up must not block installation.
  } finally {
    if (timer) clearTimeout(timer);
  }
  return false;
}

// Fills any gap in the cache. Used on install, on activate and on demand,
// so an eviction repairs itself the next time the app is opened online.
async function warmMissing(force) {
  const report = { stored: 0, missing: [] };
  try {
    const cache = await caches.open(CACHE);

    const one = async url => {
      const hit = force ? null : await cache.match(url, { ignoreSearch: true });
      if (hit) { report.stored++; return; }
      const ok = await safeCache(cache, url);
      if (ok) report.stored++; else report.missing.push(url);
    };

    // Same-origin files first and one at a time: these decide whether the app
    // can open at all, and must not queue behind a slow CDN.
    for (const url of LOCAL_WARM) await one(url);

    // The libraries are independent of each other, so they are fetched in
    // parallel; the worst case is one timeout rather than four in a row.
    await Promise.all(LIB_WARM.map(one));
  } catch (e) {
    report.error = String((e && e.message) || e);
  }
  return report;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await warmMissing(true);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      // Only old versioned caches are removed; the working cache stays.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter(k => k !== CACHE && k.startsWith('recipe-notebook-'))
            .map(k => caches.delete(k))
      );
    } catch (e) { /* stale caches are harmless */ }

    // Repair a cache that an earlier version emptied or that iOS evicted,
    // so the app stops being stuck offline-broken after an update.
    await warmMissing(false);

    await self.clients.claim();
  })());
});

// Lets the page ask for a repair and get a real answer back, instead of the
// page and the worker each keeping their own idea of what is stored.
self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'warm-cache') {
    event.waitUntil((async () => {
      const report = await warmMissing(!!data.force);
      try {
        if (event.source) event.source.postMessage({ type: 'warm-result', report });
      } catch (e) { /* the page may have gone away */ }
    })());
  }
});

// Compares the freshly fetched shell with the cached one and tells any open
// page if it changed, so the person can choose when to pick up the update.
// Headers identify a build without reading the body, which would otherwise
// mean parsing the whole page twice on every launch.
function responseSignature(res) {
  try {
    const h = res.headers;
    return (h.get('etag') || '') + '|' +
           (h.get('last-modified') || '') + '|' +
           (h.get('content-length') || '');
  } catch (e) { return ''; }
}

async function notifyUpdateAvailable() {
  try {
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'update-ready' }));
  } catch (e) { /* best effort */ }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  if (isApiHost(url.hostname)) return;

  // The diagnosis screen probes each file with a unique ?probe= value. Those
  // must go straight to the network and must never be stored: cached under
  // their unique URLs they would accumulate one dead entry per press.
  if (url.searchParams && url.searchParams.has('probe')) return;

  // The Firebase config decides which project the app talks to, so a stale
  // copy must never be served ahead of the real one.
  if (url.origin === self.location.origin && url.pathname.endsWith('/firebase-config.json')) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      } catch (e) {
        const cached = await caches.match(req);
        // A plain 404 keeps the app on its built-in config, which is correct
        // when no override file was ever deployed.
        return cached || new Response('{}', {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    })());
    return;
  }

  // Page loads: cache first. Waiting on the network here was the cause of slow
  // starts on a weak signal — a struggling connection takes far longer to fail
  // than to simply not be used. The cached shell is returned at once and a
  // fresh copy is fetched in the background for next time. Everything is
  // normalised onto SHELL_KEY, so a query string or /index.html cannot miss.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match(SHELL_KEY, { ignoreSearch: true });

      // Cloned up front: once a response is returned to the browser its body
      // is consumed, and cloning it afterwards throws.
      const cachedSignature = cached ? responseSignature(cached) : null;

      const refresh = fetch(req).then(res => {
        if (res && res.ok) {
          caches.open(CACHE).then(c => c.put(SHELL_KEY, res.clone())).catch(() => {});
          if (cachedSignature && responseSignature(res) !== cachedSignature) {
            notifyUpdateAvailable();
          }
        }
        return res;
      }).catch(() => null);

      if (cached) return cached;

      // Nothing cached yet: this is a first run, so the network is the only
      // option — but it is capped so it can never hang indefinitely.
      const timed = await Promise.race([
        refresh,
        new Promise(r => setTimeout(() => r(null), 8000))
      ]);
      if (timed) return timed;

      return new Response(
        '<!doctype html><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<body style="font-family:sans-serif;padding:40px;text-align:center">' +
        '<h3>オフラインです</h3>' +
        '<p>一度オンラインでアプリを開くと、次回から通信なしで使えるようになります。</p>' +
        '</body>',
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    })());
    return;
  }

  // CDN libraries: cache first, since they are version-pinned.
  if (isLibHost(url.hostname)) {
    event.respondWith((async () => {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) {
          const cache = await caches.open(CACHE);
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      } catch (e) {
        return Response.error();
      }
    })());
    return;
  }

  // Same-origin assets: serve the cached copy, refresh in the background.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) {
        // Refresh quietly for next time; failures are irrelevant here.
        fetch(req).then(res => {
          if (res && res.ok) {
            caches.open(CACHE).then(c => c.put(req, res.clone())).catch(() => {});
          }
        }).catch(() => {});
        return cached;
      }
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          caches.open(CACHE).then(c => c.put(req, res.clone())).catch(() => {});
        }
        return res;
      } catch (e) {
        // Returning undefined from respondWith produces a network error with
        // no explanation; an explicit error response is at least honest.
        return Response.error();
      }
    })());
  }
});
