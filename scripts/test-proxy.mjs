/**
 * Eigakan path-proxy tests — run: npm run test:proxy
 *
 * Imports proxy/src/index.js directly (plain JS module) and stubs global
 * fetch() to record where each request WOULD be forwarded, so the routing,
 * prefix stripping and redirect rules are verified without any Cloudflare
 * account or network.
 */
import assert from 'node:assert/strict';
import worker from '../proxy/src/index.js';

const env = {
  PAGES_ORIGIN: 'https://eigakan.pages.dev',
  ROOM_ORIGIN: 'https://eigakan-room.example.workers.dev',
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

console.log(`\n${passed}/10 path-proxy checks passed`);

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
