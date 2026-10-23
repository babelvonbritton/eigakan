/* Eigakan service worker — present so Chrome can offer PWA installation.
 *
 * Deliberately network-only: it caches nothing, stores nothing, and never
 * answers a request itself. The password gate, the live build, and the
 * room WebSocket all behave exactly as if this file were not here.
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Pass-through: not calling respondWith lets the browser use the
  // network normally. The listener's existence is what installability
  // checks look for.
});
