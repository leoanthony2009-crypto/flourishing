// Bloom Principal Pulse — service worker.
//
// One job: make the app open on a bad connection. School wifi in Trinidad is not reliable, and
// an app built around a weekly habit that shows a browser error page on Monday morning does not
// become a habit.
//
// The hard rule here is about privacy, not caching. Every Supabase response is scoped to one
// principal's school by row-level security, so a cached copy on a shared or handed-over device
// would be a leak that RLS cannot help with. This worker therefore touches SAME-ORIGIN STATIC
// ASSETS ONLY and never inspects, stores or replays an API response. Anything cross-origin —
// Supabase, the Anthropic proxy, fonts — falls straight through to the network untouched.
const CACHE = 'bloom-shell-v1';

// The shell. index.html is a single self-contained bundle, so this is nearly the whole app.
const SHELL = ['/', '/index.html', '/privacy.html', '/supabase.js', '/manifest.webmanifest',
               '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/favicon.ico'];

self.addEventListener('install', (e) => {
  // addAll fails the whole install if any one request fails, which would leave no worker at
  // all. Cache what we can and let a missing icon be a missing icon.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Only ever GET, only ever this origin. Everything else — every Supabase call, every edge
  // function, every font — is left entirely alone.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Navigations go to the network first so a new deploy is picked up the moment someone is
  // online; the cache is the fallback, not the source of truth. Cache-first here would pin a
  // principal to whichever build they happened to install, which for a single-file 3MB bundle
  // means missing every fix until they cleared their browser.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        // Keep the shell under '/index.html' so any route (?staff=1, /inbox) falls back to a
        // page that exists rather than to whatever was requested last.
        if (fresh && fresh.ok) (await caches.open(CACHE)).put('/index.html', fresh.clone());
        return fresh;
      } catch (err) {
        const c = await caches.open(CACHE);
        return (await c.match('/index.html')) || (await c.match('/')) || Response.error();
      }
    })());
    return;
  }

  // Static assets: cache first, and refresh the copy in the background when online.
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req);
    if (hit) {
      e.waitUntil(fetch(req).then((r) => { if (r && r.ok) c.put(req, r.clone()); }).catch(() => {}));
      return hit;
    }
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) c.put(req, fresh.clone());
      return fresh;
    } catch (err) {
      return Response.error();
    }
  })());
});

// Lets the app drop the cache on sign-out, so a shared device keeps nothing behind.
self.addEventListener('message', (e) => {
  if (e.data === 'bloom-clear-cache') caches.delete(CACHE);
});
