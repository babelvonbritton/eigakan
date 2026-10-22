// @ts-check
import { defineConfig } from 'astro/config';

/**
 * Eigakan web — a static Astro site.
 *
 * PUBLIC_ROOM_API_URL points at the room Worker (see ../worker). Locally the
 * worker runs at http://localhost:8787 via `wrangler dev`.
 *
 * PUBLIC_SITE_BASE sets the URL path the site is served under. Locally and on
 * a (sub)domain root it is `/`. For path hosting — https://<domain>/eigakan —
 * set PUBLIC_SITE_BASE=/eigakan (with PUBLIC_SITE_URL = the bare origin,
 * https://<domain>) in the Pages build environment and serve the Pages
 * origin behind the path-proxy worker (see ../proxy). Astro exposes the
 * resolved base to code as import.meta.env.BASE_URL — note it has NO
 * trailing slash when a base is set ('/eigakan', vs '/' at the root), so
 * client code normalizes it before joining paths (see the pages).
 */
const roomApiUrl = process.env.PUBLIC_ROOM_API_URL || 'http://localhost:8787';

export default defineConfig({
  site: process.env.PUBLIC_SITE_URL || 'http://localhost:4321',
  base: process.env.PUBLIC_SITE_BASE || '/',
  vite: {
    define: {
      'import.meta.env.PUBLIC_ROOM_API_URL': JSON.stringify(roomApiUrl),
    },
  },
});
