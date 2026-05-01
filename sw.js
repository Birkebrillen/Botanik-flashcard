/**
 * sw.js — Service Worker for offline-funktionalitet
 *
 * Strategi:
 *   - App-shell (HTML/CSS/JS): cache-first, opdateres ved version-bump
 *   - Datafiler: stale-while-revalidate (server bruges, cache fallback)
 *   - Billeder fra Cloudflare R2: cache-first, dynamisk (kun set arter)
 *
 * Bump CACHE_VERSION når app-koden opdateres.
 */

const CACHE_VERSION = "v6";
const APP_CACHE = `botanik-app-${CACHE_VERSION}`;
const DATA_CACHE = `botanik-data-${CACHE_VERSION}`;
const IMAGE_CACHE = `botanik-images-${CACHE_VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./css/main.css",
  "./js/main.js",
  "./js/data.js",
  "./js/search.js",
  "./js/views/home.js",
  "./js/views/lookup.js",
  "./js/views/species-detail.js",
  "./js/views/training.js",
  "./manifest.json",
];

const DATA_FILES = [
  "./data/botanik_final.json",
  "./data/vocabulary.json",
  "./data/synonyms.json",
  "./data/image_manifest.json",
];

const IMAGES_HOST = "pub-9b629f8090a54a769ad120596348dde3.r2.dev";


// ============================================================================
// INSTALL — pre-cache app shell og datafiler
// ============================================================================

self.addEventListener("install", event => {
  event.waitUntil(
    Promise.all([
      caches.open(APP_CACHE).then(cache => cache.addAll(APP_SHELL)),
      caches.open(DATA_CACHE).then(cache => cache.addAll(DATA_FILES)),
    ]).then(() => self.skipWaiting())
  );
});


// ============================================================================
// ACTIVATE — slet gamle cacher
// ============================================================================

self.addEventListener("activate", event => {
  const validCaches = new Set([APP_CACHE, DATA_CACHE, IMAGE_CACHE]);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k.startsWith("botanik-") && !validCaches.has(k))
            .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});


// ============================================================================
// FETCH — strategi pr. ressource-type
// ============================================================================

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // 1) Billeder fra Cloudflare R2 → cache-first
  if (url.host === IMAGES_HOST) {
    event.respondWith(cacheFirst(req, IMAGE_CACHE));
    return;
  }

  // 2) Datafiler → stale-while-revalidate
  if (url.pathname.includes("/data/") && url.pathname.endsWith(".json")) {
    event.respondWith(staleWhileRevalidate(req, DATA_CACHE));
    return;
  }

  // 3) App shell → cache-first med network fallback
  event.respondWith(cacheFirst(req, APP_CACHE));
});


// ============================================================================
// STRATEGIER
// ============================================================================

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Hvis offline og ikke i cache: returnér en simpel fejl
    return new Response("Offline og ikke i cache", {
      status: 503,
      statusText: "Service Unavailable",
    });
  }
}


async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request).then(response => {
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  return cached || networkFetch || new Response("Offline", { status: 503 });
}
