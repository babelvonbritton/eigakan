/**
 * Eigakan path proxy — serves Eigakan under a path on an existing domain:
 *
 *   https://<domain>/eigakan       → the Pages site  (env.PAGES_ORIGIN)
 *   https://<domain>/eigakan-api   → the room Worker (env.ROOM_ORIGIN)
 *
 * Cloudflare binds custom domains and routes to hostnames, not paths, so
 * this Worker sits on the domain's zone with two routes
 * (`<domain>/eigakan*` and `<domain>/eigakan-api*`) and forwards each
 * request to the right origin with its prefix stripped. Everything else on
 * the domain is untouched — routes only match those two prefixes.
 *
 * Because the site and the API share one public origin this way, the room
 * client needs no cross-origin calls at all when PUBLIC_ROOM_API_URL is set
 * to https://<domain>/eigakan-api.
 *
 * WebSocket upgrades pass straight through fetch(): the runtime pairs the
 * client socket with the origin socket transparently.
 */

const SITE_PREFIX = '/eigakan';
const API_PREFIX = '/eigakan-api';

function forward(request, origin, prefix) {
  const url = new URL(request.url);
  const rest = url.pathname.slice(prefix.length) || '/';
  const target = new URL(rest + url.search, origin);
  // Rebuild the request against the origin, keeping method, headers and body.
  // `redirect: 'manual'` so origin redirects reach the browser untouched and
  // the browser resolves them against the public (prefixed) URL.
  return fetch(new Request(target, request), { redirect: 'manual' });
}

export default {
  /** @param {Request} request @param {{PAGES_ORIGIN: string, ROOM_ORIGIN: string}} env */
  async fetch(request, env) {
    const url = new URL(request.url);

    // Bare /eigakan → /eigakan/ so relative resolution and the Astro base
    // behave consistently.
    if (url.pathname === SITE_PREFIX) {
      url.pathname = SITE_PREFIX + '/';
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === API_PREFIX) {
      url.pathname = API_PREFIX + '/';
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname.startsWith(API_PREFIX + '/')) {
      return forward(request, env.ROOM_ORIGIN, API_PREFIX);
    }
    if (url.pathname.startsWith(SITE_PREFIX + '/')) {
      return forward(request, env.PAGES_ORIGIN, SITE_PREFIX);
    }

    // The routes should prevent anything else reaching this Worker; if a
    // broader route is ever configured, refuse rather than swallow traffic
    // meant for the main site.
    return new Response('Not found', { status: 404 });
  },
};
