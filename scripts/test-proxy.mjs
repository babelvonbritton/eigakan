/**
 * Eigakan path-proxy tests — run: npm run test:proxy
 *
 * Imports proxy/src/index.js directly (plain JS module) and stubs global
 * fetch() to record where each request WOULD be forwarded, so the routing,
 * prefix stripping and redirect rules are verified without any Cloudflare
 * account or network.
 */
import assert from 'node:assert/strict';
import worker, { LoginAttempts } from '../proxy/src/index.js';

const limiterStates = new Map();
const namespace = {
  idFromName: (name) => name,
  get(id) {
    let instance = limiterStates.get(id);
    if (!instance) {
      const data = new Map();
      const storage = {
        get: async (key) => data.get(key),
        put: async (key, value) => data.set(key, value),
        delete: async (key) => data.delete(key),
        transaction: async (callback) => callback(storage),
      };
      instance = new LoginAttempts({ storage });
      limiterStates.set(id, instance);
    }
    return { fetch: (input, init) => instance.fetch(new Request(input, init)) };
  },
};

const env = {
  PAGES_ORIGIN: 'https://eigakan.pages.dev',
  ROOM_ORIGIN: 'https://eigakan-room.example.workers.dev',
  LOGIN_ATTEMPTS: namespace,
};

let lastTarget = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (req) => {
  lastTarget = req.url;
  return new Response('origin-body', { status: 200, headers: { 'x-origin': 'stub' } });
};

const run = async (path, init) => worker.fetch(new Request('https://example.com' + path, init), env);

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`  ok — ${name}`); };

try {
  await check('bare /eigakan redirects to /eigakan/', async () => {
    const res = await run('/eigakan');
    assert.equal(res.status, 301);
    assert.equal(new URL(res.headers.get('location')).pathname, '/eigakan/');
  });

  await check('site root forwards to Pages origin /', async () => {
    const res = await run('/eigakan/');
    assert.equal(res.status, 200);
    assert.equal(lastTarget, 'https://eigakan.pages.dev/');
  });

  await check('watch page forwards with query intact', async () => {
    await run('/eigakan/watch?room=ABC123&host=1');
    assert.equal(lastTarget, 'https://eigakan.pages.dev/watch?room=ABC123&host=1');
  });

  await check('hashed asset path forwards untouched', async () => {
    await run('/eigakan/_astro/index.abc123.js');
    assert.equal(lastTarget, 'https://eigakan.pages.dev/_astro/index.abc123.js');
  });

  await check('api health forwards to room origin', async () => {
    await run('/eigakan-api/health');
    assert.equal(lastTarget, 'https://eigakan-room.example.workers.dev/health');
  });

  await check('room websocket path forwards to room origin', async () => {
    await run('/eigakan-api/rooms/ABC123/ws');
    assert.equal(lastTarget, 'https://eigakan-room.example.workers.dev/rooms/ABC123/ws');
  });

  await check('HLS playlist path forwards to room origin', async () => {
    await run('/eigakan-api/rooms/ABC123/hls/movie/master.m3u8?exp=1&sig=ab');
    assert.equal(lastTarget, 'https://eigakan-room.example.workers.dev/rooms/ABC123/hls/movie/master.m3u8?exp=1&sig=ab');
  });

  await check('lookalike prefix /eigakanx is NOT captured', async () => {
    const res = await run('/eigakanx/page');
    assert.equal(res.status, 404);
  });

  await check('unrelated path returns 404', async () => {
    const res = await run('/blog/post');
    assert.equal(res.status, 404);
  });

  await check('local dev Vite assets forward to the Astro server', async () => {
    const localDevEnv = {
      ...env,
      PAGES_ORIGIN: 'http://localhost:4321',
      LOCAL_DEV: 'true',
    };
    const res = await worker.fetch(
      new Request('http://localhost:8788/src/pages/index.astro'),
      localDevEnv,
    );
    assert.equal(res.status, 200);
    assert.equal(lastTarget, 'http://localhost:4321/src/pages/index.astro');
  });

  await check('POST body is preserved when forwarding', async () => {
    let seenBody = null;
    globalThis.fetch = async (req) => { seenBody = await req.text(); return new Response('ok'); };
    await run('/eigakan-api/health', { method: 'POST', body: 'ping-body' });
    assert.equal(seenBody, 'ping-body');
    globalThis.fetch = async (req) => { lastTarget = req.url; return new Response('origin-body'); };
  });
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${passed}/11 path-proxy checks passed`);

// ——— shared-password gate (env.SITE_PASSWORD set) ———
// (the main suite restored the real fetch in its finally block; stub again)
globalThis.fetch = async (req) => {
  lastTarget = req.url;
  return new Response('origin-body', { status: 200, headers: { 'x-origin': 'stub' } });
};
const gatedEnv = { ...env, SITE_PASSWORD: 'correct horse battery' };
const grun = async (path, init) => worker.fetch(new Request('https://example.com' + path, init), gatedEnv);

await check('gate: unauthenticated site path redirects to login', async () => {
  const res = await grun('/eigakan/');
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get('location')).pathname, '/eigakan-login');
});

await check('gate: login page is served', async () => {
  const res = await grun('/eigakan-login');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('EIGAKAN') && body.includes('type="password"'));
  assert.ok(body.includes('class="visibility-toggle"') && body.includes('password-visibility-slash'));
  assert.ok(body.includes('.visibility-toggle.password-visible #password-visibility-slash { display: none; }'));
  assert.ok(body.includes("classList.toggle('password-visible', showPassword)"));
});

await check('gate: wrong password gets no cookie', async () => {
  const res = await grun('/eigakan-login', {
    method: 'POST',
    body: new URLSearchParams({ password: 'nope' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
});

let gateCookie = '';
await check('gate: correct password sets the gate cookie and redirects in', async () => {
  const res = await grun('/eigakan-login', {
    method: 'POST',
    body: new URLSearchParams({ password: 'correct horse battery' }),
  });
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get('location')).pathname, '/eigakan/');
  gateCookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  assert.ok(gateCookie.startsWith('eigakan_gate='));
});

await check('gate: cookie admits the site', async () => {
  const res = await grun('/eigakan/', { headers: { Cookie: gateCookie } });
  assert.equal(res.status, 200);
  assert.equal(lastTarget, 'https://eigakan.pages.dev/');
});

await check('gate: PWA plumbing is public (browsers fetch it outside the session)', async () => {
  for (const [path, target] of [
    ['/eigakan/manifest.webmanifest', 'https://eigakan.pages.dev/manifest.webmanifest'],
    ['/eigakan/sw.js', 'https://eigakan.pages.dev/sw.js'],
    ['/eigakan/favicon.svg', 'https://eigakan.pages.dev/favicon.svg'],
    ['/eigakan/icons/icon-192.png', 'https://eigakan.pages.dev/icons/icon-192.png'],
  ]) {
    const res = await grun(path);
    assert.equal(res.status, 200, path);
    assert.equal(lastTarget, target, path);
  }
});

await check('gate: pages other than plumbing still redirect to login', async () => {
  const res = await grun('/eigakan/watch/');
  assert.equal(res.status, 302);
});

await check('gate: API refuses without the cookie (401)', async () => {
  const res = await grun('/eigakan-api/health');
  assert.equal(res.status, 401);
});

await check('gate: API forwards with the cookie', async () => {
  const res = await grun('/eigakan-api/health', { headers: { Cookie: gateCookie } });
  assert.equal(res.status, 200);
  assert.equal(lastTarget, 'https://eigakan-room.example.workers.dev/health');
});

await check('gate: a forged cookie is rejected', async () => {
  const res = await grun('/eigakan/', { headers: { Cookie: 'eigakan_gate=deadbeef' } });
  assert.equal(res.status, 302);
});

await check('gate: five failed passwords trigger a five-minute IP lockout', async () => {
  const ip = '192.0.2.10';
  for (let i = 0; i < 5; i++) {
    const res = await grun('/eigakan-login', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': ip },
      body: new URLSearchParams({ password: 'nope' }),
    });
    assert.equal(res.status, 200);
  }
  const blocked = await grun('/eigakan-login', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip },
    body: new URLSearchParams({ password: 'nope' }),
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '300');
  const otherIp = await grun('/eigakan-login', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '192.0.2.12' },
    body: new URLSearchParams({ password: 'correct horse battery' }),
  });
  assert.equal(otherIp.status, 302);
});

await check('gate: successful login clears that IP’s failure count', async () => {
  const ip = '192.0.2.11';
  for (let i = 0; i < 4; i++) {
    await grun('/eigakan-login', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': ip },
      body: new URLSearchParams({ password: 'nope' }),
    });
  }
  const success = await grun('/eigakan-login', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip },
    body: new URLSearchParams({ password: 'correct horse battery' }),
  });
  assert.equal(success.status, 302);
  const afterSuccess = await grun('/eigakan-login', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip },
    body: new URLSearchParams({ password: 'nope' }),
  });
  assert.equal(afterSuccess.status, 200);
});

// ——— Turnstile bot filter (env.TURNSTILE_SECRET_KEY set) ———
// The worker verifies tokens through global fetch, so the stub answers
// siteverify directly: only 'valid-turnstile-token' passes, for the test
// origin's hostname. Everything else still forwards to the stub origin.
globalThis.fetch = async (req, init) => {
  // siteverify is called with a plain URL string + init, while forwards
  // pass a Request; handle both shapes.
  const url = typeof req === 'string' ? req : req.url;
  if (url.includes('challenges.cloudflare.com/turnstile')) {
    const bodyText = typeof req === 'string' ? String(init?.body ?? '') : await req.text();
    const params = new URLSearchParams(bodyText);
    const ok = params.get('response') === 'valid-turnstile-token' && params.get('secret') === 'test-turnstile-secret';
    return Response.json({ success: ok, hostname: 'example.com' });
  }
  lastTarget = url;
  return new Response('origin-body', { status: 200, headers: { 'x-origin': 'stub' } });
};
const turnstileEnv = { ...gatedEnv, TURNSTILE_SITE_KEY: 'test-sitekey', TURNSTILE_SECRET_KEY: 'test-turnstile-secret' };
const trun = async (path, init) => worker.fetch(new Request('https://example.com' + path, init), turnstileEnv);

await check('turnstile: login page renders the widget and a nonce CSP', async () => {
  const res = await trun('/eigakan-login');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('class="cf-turnstile"') && body.includes('data-sitekey="test-sitekey"'));
  assert.ok(body.includes('https://challenges.cloudflare.com/turnstile/v0/api.js'));
  const csp = res.headers.get('content-security-policy') ?? '';
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce, `CSP carries a nonce: ${csp}`);
  assert.ok(body.includes(`<script nonce="${nonce}">`), 'inline script carries the CSP nonce');
  assert.ok(csp.includes("frame-ancestors 'none'"));
  // The widget renders inside a cross-origin iframe from challenges.cloudflare.com,
  // so the CSP must explicitly allow framing it — default-src 'none' alone blocks it
  // and no token can ever be produced (regression: every browser login failed).
  assert.ok(csp.includes('frame-src https://challenges.cloudflare.com'), `CSP allows the Turnstile iframe: ${csp}`);
});

await check('turnstile: POST without a token is refused, no cookie', async () => {
  const res = await trun('/eigakan-login', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '192.0.2.20' },
    body: new URLSearchParams({ password: 'correct horse battery' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
});

await check('turnstile: bad token is refused, no cookie', async () => {
  const res = await trun('/eigakan-login', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '192.0.2.21' },
    body: new URLSearchParams({ password: 'correct horse battery', 'cf-turnstile-response': 'bogus-token' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
});

await check('turnstile: failed verifications do not feed the lockout', async () => {
  const ip = '192.0.2.22';
  for (let i = 0; i < 5; i++) {
    const res = await trun('/eigakan-login', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': ip },
      body: new URLSearchParams({ password: 'correct horse battery' }),
    });
    assert.equal(res.status, 200);
  }
  const res = await trun('/eigakan-login', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip },
    body: new URLSearchParams({ password: 'correct horse battery', 'cf-turnstile-response': 'valid-turnstile-token' }),
  });
  assert.equal(res.status, 302);
  assert.ok((res.headers.get('set-cookie') ?? '').startsWith('eigakan_gate='));
});
