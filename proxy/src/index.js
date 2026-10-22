/**
 * Eigakan path proxy — serves Eigakan under a path on an existing domain:
 *
 *   https://<domain>/eigakan       → the Pages site  (env.PAGES_ORIGIN)
 *   https://<domain>/eigakan-api   → the room Worker (env.ROOM_ORIGIN)
 *
 * Cloudflare binds custom domains and routes to hostnames, not paths, so
 * this Worker sits on the domain's zone with routes for the two prefixes
 * (plus `<domain>/eigakan-login*` for the gate below) and forwards each
 * request to the right origin with its prefix stripped. Everything else on
 * the domain is untouched — routes only match those prefixes.
 *
 * Because the site and the API share one public origin this way, the room
 * client needs no cross-origin calls at all when PUBLIC_ROOM_API_URL is set
 * to https://<domain>/eigakan-api.
 *
 * WebSocket upgrades pass straight through fetch(): the runtime pairs the
 * client socket with the origin socket transparently.
 *
 * ——— Shared-password gate (optional, env.SITE_PASSWORD) ———
 * When the SITE_PASSWORD secret is set on this Worker, the whole Eigakan
 * path is behind one shared password: visitors without a valid gate cookie
 * are redirected to a themed login page at /eigakan-login; the API prefix
 * answers 401 instead. The cookie is an HMAC of a fixed marker keyed by the
 * password, so it never contains the password itself, and changing the
 * password instantly invalidates every issued cookie. When SITE_PASSWORD is
 * unset (local development), the gate is off and the proxy just forwards.
 * The password itself only ever lives as a Worker secret — never in the
 * repo, never in the built site.
 */

const SITE_PREFIX = '/eigakan';
const API_PREFIX = '/eigakan-api';
const LOGIN_PATH = '/eigakan-login';
const COOKIE_NAME = 'eigakan_gate';
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000;

function forward(request, origin, prefix) {
  const url = new URL(request.url);
  const rest = url.pathname.slice(prefix.length) || '/';
  const target = new URL(rest + url.search, origin);
  // Rebuild the request against the origin, keeping method, headers and body.
  // `redirect: 'manual'` so origin redirects reach the browser untouched and
  // the browser resolves them against the public (prefixed) URL.
  return fetch(new Request(target, request), { redirect: 'manual' });
}

async function hmacHex(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Expected cookie value for the current password. */
const gateToken = (password) => hmacHex(password, 'eigakan-gate-v1');

function readCookie(request, name) {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

/** Constant-work comparison (both sides are fixed-length hex digests). */
function digestsEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function isGatedIn(request, password) {
  const presented = readCookie(request, COOKIE_NAME);
  if (!presented) return false;
  return digestsEqual(presented, await gateToken(password));
}

async function loginAttemptsFor(request, env) {
  const address = request.headers.get('CF-Connecting-IP') || 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address));
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return env.LOGIN_ATTEMPTS.get(env.LOGIN_ATTEMPTS.idFromName(key));
}

function lockedOutResponse(retryAfter) {
  const minutes = Math.max(1, Math.ceil(retryAfter / 60));
  return loginPage(`Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, 429, {
    'Retry-After': String(retryAfter),
  });
}

function loginPage(error = '', status = 200, headers = {}) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Eigakan — Members only</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background:
      radial-gradient(700px 320px at 50% 0%, rgba(238,138,29,.14), rgba(238,138,29,0) 65%),
      #050403;
    color: #f3ead9; font-family: "Segoe UI", system-ui, sans-serif; padding: 1.5rem;
  }
  .card {
    width: 100%; max-width: 380px; background: #120e0a; border: 1px solid #33261a;
    border-radius: 14px; padding: 2rem 1.8rem; box-shadow: 0 30px 80px rgba(0,0,0,.65);
    text-align: center;
  }
  .wordmark {
    font-size: 2rem; font-weight: 800; letter-spacing: .28em; margin: 0 0 .4rem;
    background: linear-gradient(92deg, #d96a06, #ee8a1d 55%, #ffc15c);
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  }
  p { color: #b8a888; font-size: .92rem; margin: .3rem 0 1.2rem; }
  .error { color: #ff9d7a; min-height: 1.2em; margin-bottom: .6rem; font-size: .9rem; }
  input {
    width: 100%; padding: .7rem .9rem; border-radius: 9px; border: 1px solid #33261a;
    background: #0a0806; color: #f3ead9; font-size: 1rem; margin-bottom: .8rem;
  }
  input:focus { outline: 2px solid #d96a06; outline-offset: 1px; }
  .password-field { position: relative; margin-bottom: .8rem; }
  .password-field input { margin-bottom: 0; padding-right: 3rem; }
  button {
    width: 100%; padding: .7rem; border: 0; border-radius: 9px; cursor: pointer;
    font-size: 1rem; font-weight: 700; color: #1a0f02;
    background: linear-gradient(92deg, #d96a06, #ee8a1d 60%, #ffc15c);
  }
  .visibility-toggle {
    position: absolute; top: 50%; right: .65rem; transform: translateY(-50%);
    display: grid; place-items: center; width: 2rem; height: 2rem; padding: .35rem;
    border: 0; border-radius: 6px; color: #b8a888; background: transparent;
  }
  .visibility-toggle:hover { color: #f3ead9; background: #33261a; }
  .visibility-toggle:focus-visible { outline: 2px solid #d96a06; outline-offset: 1px; }
  .visibility-toggle svg { width: 1.2rem; height: 1.2rem; }
  .visibility-toggle.password-visible #password-visibility-slash { display: none; }
</style>
</head>
<body>
  <form class="card" method="post" action="${LOGIN_PATH}">
    <div class="wordmark">EIGAKAN</div>
    <p>This theater is private. Enter the shared password to take your seat.</p>
    <div class="error">${error}</div>
    <div class="password-field">
      <input id="password" type="password" name="password" placeholder="Shared password" autocomplete="current-password" autofocus required />
      <button class="visibility-toggle" type="button" aria-label="Show password" title="Show password">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
          <circle cx="12" cy="12" r="3" />
          <path id="password-visibility-slash" d="m3 3 18 18" />
        </svg>
      </button>
    </div>
    <button type="submit">Enter</button>
  </form>
  <script>
    const passwordInput = document.getElementById('password');
    const visibilityToggle = document.querySelector('.visibility-toggle');
    visibilityToggle.addEventListener('click', () => {
      const showPassword = passwordInput.type === 'password';
      passwordInput.type = showPassword ? 'text' : 'password';
      visibilityToggle.classList.toggle('password-visible', showPassword);
      visibilityToggle.setAttribute('aria-label', showPassword ? 'Hide password' : 'Show password');
      visibilityToggle.title = showPassword ? 'Hide password' : 'Show password';
    });
  </script>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

export class LoginAttempts {
  constructor(ctx) {
    this.storage = ctx.storage;
  }

  async fetch(request) {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const operation = new URL(request.url).pathname;
    if (!['/check', '/failure', '/success'].includes(operation)) {
      return new Response('Not found', { status: 404 });
    }

    return this.storage.transaction(async (storage) => {
      const now = Date.now();
      const state = await storage.get('state') ?? { failures: 0, blockedUntil: 0 };
      if (state.blockedUntil > now) {
        const retryAfter = Math.ceil((state.blockedUntil - now) / 1000);
        return new Response(null, { status: 429, headers: { 'Retry-After': String(retryAfter) } });
      }

      if (operation === '/success' || state.blockedUntil > 0) {
        await storage.delete('state');
        return new Response(null, { status: 204 });
      }
      if (operation === '/check') return new Response(null, { status: 204 });

      state.failures++;
      if (state.failures >= MAX_LOGIN_FAILURES) {
        state.blockedUntil = now + LOGIN_LOCKOUT_MS;
      }
      await storage.put('state', state);
      return new Response(null, { status: 204 });
    });
  }
}

export default {
  /**
   * @param {Request} request
   * @param {{PAGES_ORIGIN: string, ROOM_ORIGIN: string, SITE_PASSWORD?: string, LOGIN_ATTEMPTS: DurableObjectNamespace<LoginAttempts>}} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const password = env.SITE_PASSWORD || '';
    const gateOn = password.length > 0;

    // ——— the login page itself (never gated) ———
    if (url.pathname === LOGIN_PATH) {
      if (!gateOn) return Response.redirect(new URL(SITE_PREFIX + '/', url).toString(), 302);
      if (request.method === 'POST') {
        const attempts = await loginAttemptsFor(request, env);
        const rateLimit = await attempts.fetch('https://login-attempts/check', { method: 'POST' });
        if (rateLimit.status === 429) {
          return lockedOutResponse(Number(rateLimit.headers.get('Retry-After')) || 300);
        }

        const form = await request.formData().catch(() => null);
        const presented = String(form?.get('password') ?? '');
        const [presentedDigest, passwordDigest] = await Promise.all([
          hmacHex(presented, 'eigakan-gate-v1'),
          gateToken(password),
        ]);
        if (presentedDigest === passwordDigest) {
          await attempts.fetch('https://login-attempts/success', { method: 'POST' });
          const token = await gateToken(password);
          return new Response(null, {
            status: 302,
            headers: {
              Location: new URL(SITE_PREFIX + '/', url).toString(),
              'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
            },
          });
        }
        const failure = await attempts.fetch('https://login-attempts/failure', { method: 'POST' });
        if (failure.status === 429) {
          return lockedOutResponse(Number(failure.headers.get('Retry-After')) || 300);
        }
        return loginPage('That password does not match. Try again.');
      }
      return loginPage();
    }

    // Bare prefixes → trailing slash so relative resolution and the Astro
    // base behave consistently.
    if (url.pathname === SITE_PREFIX) {
      url.pathname = SITE_PREFIX + '/';
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === API_PREFIX) {
      url.pathname = API_PREFIX + '/';
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname.startsWith(API_PREFIX + '/')) {
      // The API refuses the unauthenticated outright (no login redirect —
      // a WebSocket cannot follow one to a form anyway).
      if (gateOn && !(await isGatedIn(request, password))) {
        return Response.json({ error: 'Eigakan is password-protected. Open the site and enter the shared password first.' }, { status: 401 });
      }
      return forward(request, env.ROOM_ORIGIN, API_PREFIX);
    }
    if (url.pathname.startsWith(SITE_PREFIX + '/')) {
      if (gateOn && !(await isGatedIn(request, password))) {
        return Response.redirect(new URL(LOGIN_PATH, url).toString(), 302);
      }
      return forward(request, env.PAGES_ORIGIN, SITE_PREFIX);
    }

    // The routes should prevent anything else reaching this Worker; if a
    // broader route is ever configured, refuse rather than swallow traffic
    // meant for the main site.
    return new Response('Not found', { status: 404 });
  },
};
