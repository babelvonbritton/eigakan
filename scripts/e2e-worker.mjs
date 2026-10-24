#!/usr/bin/env node
/**
 * Eigakan worker e2e smoke test — automated version of the manual
 * `wrangler dev` checks run for the MVP (2026-10-19) and the presign-gate
 * draft (2026-10-20), which were one-off scripts and never committed.
 *
 * Starts the room worker on a throwaway port, then drives it with real
 * WebSocket clients and asserts the movie-night contract:
 *
 *   health · invalid room code rejected · two viewers get welcome/presence
 *   play + buffer-pause events relay to the partner only · heartbeat and
 *   chat relay · a third viewer gets room-full · bad JSON gets an error,
 *   not a crash · the v0.3.0 room-session gate: welcome carries a session
 *   token, presign/HLS-mint refuse anonymous callers (401), wrong tokens
 *   (403), and pass valid room members through to the R2-config stop
 *   (501 while R2 is unconfigured locally) · a seat frees when a viewer
 *   leaves and can be taken again.
 *
 * Usage:  npm run test:e2e:worker        (from the repo root)
 * Port:   EIGAKAN_E2E_PORT (default 8789 — avoids 8787 dev / 8788 gate)
 *
 * Uses only Node's built-in WebSocket/fetch (Node >= 20) — no new deps.
 * Not part of `npm run verify`: it boots a real dev server, so run it
 * before a deployment / release, not on every CI verify.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.EIGAKAN_E2E_PORT ?? 8789);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE = Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

const results = [];
function check(label, ok, detail = '') {
  results.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- tiny WebSocket client with a message inbox ----------
class Client {
  constructor(name) {
    this.name = name;
    this.inbox = [];
    this.waiters = [];
  }
  connect(code, query = '') {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}/rooms/${code}/ws${query}`);
      this.closedFlag = false;
      ws.addEventListener('close', () => { this.closedFlag = true; });
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`${this.name}: open timeout`)), 8000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error(`${this.name}: ${e.message ?? 'socket error'}`)); }, { once: true });
      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(String(ev.data)); } catch { msg = { type: '__unparsed', raw: String(ev.data) }; }
        this.inbox.push(msg);
        this.waiters = this.waiters.filter((w) => !w(msg));
      });
    });
  }
  /** Resolve with the first already-seen or future message matching pred. */
  waitFor(pred, label, timeoutMs = 6000) {
    const seen = this.inbox.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: timeout waiting for ${label}`)), timeoutMs);
      this.waiters.push((msg) => {
        if (!pred(msg)) return false;
        clearTimeout(timer);
        resolve(msg);
        return true;
      });
    });
  }
  send(obj) { this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
  close() { try { this.ws?.close(); } catch { /* already gone */ } }
}

// ---------- boot wrangler dev ----------
let serverLog = '';
let child = null;
function boot(extraArgs = []) {
  serverLog = '';
  child = spawn(
    'npx',
    ['wrangler', 'dev', '--config', 'worker/wrangler.toml', '--port', String(PORT), '--ip', '127.0.0.1', ...extraArgs],
    { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (d) => { serverLog = (serverLog + d).slice(-4000); });
  child.stderr.on('data', (d) => { serverLog = (serverLog + d).slice(-4000); });
}
boot();

async function stopServer() {
  if (!child) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already dead */ }
  await sleep(800);
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already dead */ }
  child = null;
}

async function waitForHealth(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return res.json();
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error(`worker did not become healthy on ${BASE} within ${timeoutMs}ms\n--- wrangler log tail ---\n${serverLog}`);
}

// ---------- the run ----------
const clients = [];
try {
  const health = await waitForHealth();
  check('health endpoint', health.ok === true && health.service === 'eigakan-room', JSON.stringify(health));

  const bad = await fetch(`${BASE}/rooms/ABC10O/ws`);
  check('invalid room code -> 400', bad.status === 400, `got ${bad.status}`);

  // Two viewers join.
  const a = new Client('A'); clients.push(a);
  await a.connect(CODE, '?name=Hosty&host=1');
  const welcomeA = await a.waitFor((m) => m.type === 'welcome', 'welcome A');
  check('viewer A welcome, peers=1', welcomeA.peers === 1 && typeof welcomeA.peerId === 'string');

  const b = new Client('B'); clients.push(b);
  await b.connect(CODE, '?name=Guesty');
  const welcomeB = await b.waitFor((m) => m.type === 'welcome', 'welcome B');
  check('viewer B welcome, peers=2', welcomeB.peers === 2);
  await a.waitFor((m) => m.type === 'presence' && m.peers === 2, 'presence=2 at A');
  check('viewer A sees presence=2', true);

  // Playback event relays to the partner only.
  a.send({ type: 'event', event: { kind: 'play', videoTime: 142.5, sentAt: Date.now(), playbackRate: 1, playing: true } });
  const ev = await b.waitFor((m) => m.type === 'peer-event' && m.event?.kind === 'play', 'play relay at B');
  check('play event A -> B, position intact', ev.event.videoTime === 142.5 && typeof ev.serverReceivedAt === 'number');
  await sleep(400);
  check('sender does not receive its own event', !a.inbox.some((m) => m.type === 'peer-event'));

  // v0.2.0 pause-both-on-buffering travels as a normal playback event.
  a.send({ type: 'event', event: { kind: 'buffer-pause', videoTime: 200, sentAt: Date.now(), playbackRate: 1, playing: false } });
  await b.waitFor((m) => m.type === 'peer-event' && m.event?.kind === 'buffer-pause', 'buffer-pause relay at B');
  check('buffer-pause event A -> B (pause-both rule)', true);

  // Heartbeat + chat relay.
  a.send({ type: 'heartbeat', heartbeat: { videoTime: 143, sentAt: Date.now(), playing: true, playbackRate: 1, buffering: false } });
  await b.waitFor((m) => m.type === 'peer-heartbeat', 'heartbeat relay at B');
  check('heartbeat A -> B', true);

  b.send({ type: 'chat', text: 'ready when you are', sentAt: Date.now() });
  const chat = await a.waitFor((m) => m.type === 'peer-chat', 'chat relay at A');
  check('chat B -> A', chat.text === 'ready when you are');
  check('chat carries the sender display name', chat.name === 'Guesty', `name=${chat.name}`);
  await a.waitFor(
    (m) => m.type === 'presence' && Array.isArray(m.names) && m.names.includes('Hosty') && m.names.includes('Guesty'),
    'presence with display names at A',
  );
  check('presence carries both display names', true);

  // v0.9.3: presence also carries structured people (host flag + a per-
  // recipient isYou flag) for the avatar chips in the status bar.
  const presA = await a.waitFor(
    (m) => m.type === 'presence' && Array.isArray(m.people) && m.people.length === 2,
    'presence with people at A',
  );
  const hostyAtA = presA.people.find((p) => p.name === 'Hosty');
  const guestyAtA = presA.people.find((p) => p.name === 'Guesty');
  check('presence people: host flagged at A', hostyAtA?.isHost === true, JSON.stringify(presA.people));
  check('presence people: A sees itself as YOU', hostyAtA?.isYou === true && guestyAtA?.isYou === false);
  const presB = await b.waitFor(
    (m) => m.type === 'presence' && Array.isArray(m.people) && m.people.length === 2,
    'presence with people at B',
  );
  const guestyAtB = presB.people.find((p) => p.name === 'Guesty');
  const hostyAtB = presB.people.find((p) => p.name === 'Hosty');
  check('presence people: B sees itself as YOU', guestyAtB?.isYou === true && hostyAtB?.isYou === false);
  check('presence people: host flag agrees at B', hostyAtB?.isHost === true && guestyAtB?.isHost === false);

  // Third viewer is turned away — the max-2 rule, server-side.
  const c = new Client('C'); clients.push(c);
  await c.connect(CODE);
  await c.waitFor((m) => m.type === 'room-full', 'room-full at C');
  check('third viewer gets room-full, not welcome', !c.inbox.some((m) => m.type === 'welcome'));
  c.close();

  // Bad JSON is an error reply, not a dead room.
  a.send('this is not json{{{');
  const err = await a.waitFor((m) => m.type === 'error', 'error reply at A');
  check('invalid JSON -> error reply', /invalid json/i.test(err.message ?? ''));

  // v0.3.0 room-session gate (presign + HLS mint).
  check(
    'welcome carries a 64-hex session token',
    typeof welcomeA.sessionToken === 'string' && /^[0-9a-f]{64}$/.test(welcomeA.sessionToken),
  );
  const token = welcomeA.sessionToken;

  const presignAnon = await fetch(`${BASE}/rooms/${CODE}/files/movie.mp4/presign`);
  check('presign: anonymous caller -> 401', presignAnon.status === 401, `got ${presignAnon.status}`);

  const presignWrong = await fetch(`${BASE}/rooms/${CODE}/files/movie.mp4/presign`, {
    headers: { 'X-Room-Session': 'f'.repeat(64) },
  });
  check('presign: wrong token -> 403', presignWrong.status === 403, `got ${presignWrong.status}`);

  const presignOk = await fetch(`${BASE}/rooms/${CODE}/files/movie.mp4/presign`, {
    headers: { 'X-Room-Session': token },
  });
  check(
    'presign: valid room member passes the gate (501 = R2 unconfigured locally)',
    presignOk.status === 501,
    `got ${presignOk.status}`,
  );

  const mintAnon = await fetch(`${BASE}/rooms/${CODE}/hls/movie-hls/mint`);
  check('HLS mint: anonymous caller -> 401', mintAnon.status === 401, `got ${mintAnon.status}`);

  const mintOk = await fetch(`${BASE}/rooms/${CODE}/hls/movie-hls/mint`, {
    headers: { 'X-Room-Session': token },
  });
  check(
    'HLS mint: valid room member passes the gate (501 = R2 unconfigured locally)',
    mintOk.status === 501,
    `got ${mintOk.status}`,
  );

  const playlist = await fetch(`${BASE}/rooms/${CODE}/hls/movie-hls/master.m3u8?exp=9999999999&sig=${'a'.repeat(64)}`);
  check(
    'HLS playlist: cannot be served while R2 is unconfigured (501)',
    playlist.status === 501,
    `got ${playlist.status}`,
  );

  // A seat frees on leave and can be taken again.
  b.close();
  await a.waitFor((m) => m.type === 'presence' && m.peers === 1, 'presence=1 at A after B leaves', 8000);
  check('presence drops to 1 when B leaves', true);

  const d = new Client('D'); clients.push(d);
  await d.connect(CODE);
  const welcomeD = await d.waitFor((m) => m.type === 'welcome', 'welcome D');
  check('new viewer can take the freed seat', welcomeD.peers === 2);

  // Host terminates the room: everyone is notified and disconnected.
  d.send({ type: 'end-room' });
  await sleep(400);
  check('a non-host cannot end the room', !a.inbox.some((m) => m.type === 'room-ended'));
  a.send({ type: 'end-room' });
  await a.waitFor((m) => m.type === 'room-ended', 'room-ended at host');
  await d.waitFor((m) => m.type === 'room-ended', 'room-ended at guest');
  check('host end-room notifies both viewers', true);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !(a.closedFlag && d.closedFlag)) await sleep(100);
  check('server closes every socket on end-room', a.closedFlag && d.closedFlag);

  // ——— v0.9.0 in-site uploads: reboot with fake R2 config + a stub S3 ———
  for (const cl of clients) cl.close();
  await stopServer();
  const { createServer } = await import('node:http');
  const stubObjects = new Map();
  const stubTitles = new Map();
  const stubEscapeXml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const stubS3 = createServer((req, res) => {
    const u = new URL(req.url, 'http://stub');
    const keyFromPath = decodeURIComponent(u.pathname.replace(/^\/eigakan-movies\//, ''));
    if (req.method === 'POST' && u.searchParams.has('uploads')) {
      stubTitles.set(keyFromPath, req.headers['x-amz-meta-title'] ?? '');
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><UploadId>STUB-UPLOAD-ID</UploadId></InitiateMultipartUploadResult>');
    } else if (req.method === 'POST' && u.searchParams.has('uploadId')) {
      stubObjects.set(keyFromPath, { size: 40 * 1024 * 1024, lastModified: new Date().toISOString() });
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></CompleteMultipartUploadResult>');
    } else if (req.method === 'HEAD') {
      const object = stubObjects.get(keyFromPath);
      if (!object) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        'Content-Length': String(object.size),
        'x-amz-meta-title': stubTitles.get(keyFromPath) ?? '',
      });
      res.end();
    } else if (req.method === 'GET' && u.pathname === '/eigakan-movies' && u.searchParams.get('list-type') === '2') {
      const contents = [...stubObjects.entries()].map(([key, object]) =>
        `<Contents><Key>${stubEscapeXml(key)}</Key><LastModified>${object.lastModified}</LastModified><ETag>"stub"</ETag><Size>${object.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
      ).join('');
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>eigakan-movies</Name><Prefix>uploads/</Prefix><KeyCount>${stubObjects.size}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
    } else if (req.method === 'DELETE') {
      if (!u.searchParams.has('uploadId')) {
        stubObjects.delete(keyFromPath);
        stubTitles.delete(keyFromPath);
      }
      res.writeHead(204); res.end();
    } else {
      res.writeHead(200); res.end();
    }
  });
  await new Promise((r) => stubS3.listen(0, '127.0.0.1', r));
  const stubPort = stubS3.address().port;
  boot([
    '--var', 'R2_ACCOUNT_ID:test-account',
    '--var', 'R2_ACCESS_KEY_ID:test-key-id',
    '--var', 'R2_SECRET_ACCESS_KEY:test-secret',
    '--var', 'R2_BUCKET:eigakan-movies',
    '--var', `R2_ENDPOINT:http://127.0.0.1:${stubPort}`,
  ]);
  await waitForHealth();
  check('phase 2: worker rebooted with (stub) R2 configured', true);

  const u = new Client('U'); clients.push(u);
  await u.connect(CODE, '?name=Uploader&host=1');
  const welcomeU = await u.waitFor((m) => m.type === 'welcome', 'welcome U');
  const uToken = welcomeU.sessionToken;
  const up = (path, init = {}) =>
    fetch(`${BASE}/rooms/${CODE}/uploads/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });

  const upAnon = await up('create', { body: { filename: 'movie.mp4', size: 1024 } });
  check('uploads: anonymous create -> 401', upAnon.status === 401, `got ${upAnon.status}`);
  const upWrong = await up('create', {
    headers: { 'X-Room-Session': 'f'.repeat(64) },
    body: { filename: 'movie.mp4', size: 1024 },
  });
  check('uploads: wrong token create -> 403', upWrong.status === 403, `got ${upWrong.status}`);

  const auth = { headers: { 'X-Room-Session': uToken } };
  const badExt = await up('create', { ...auth, body: { filename: 'movie.mkv', size: 1024 } });
  check('uploads: non-playable extension -> 415', badExt.status === 415, `got ${badExt.status}`);

  const created = await up('create', { ...auth, body: { filename: 'My Movie (2026).mp4', size: 40 * 1024 * 1024 } });
  const createdBody = await created.json().catch(() => ({}));
  check(
    'uploads: create returns a room-namespaced key + uploadId',
    created.status === 200 && createdBody.uploadId === 'STUB-UPLOAD-ID' &&
      typeof createdBody.key === 'string' && createdBody.key.startsWith(`uploads/${CODE}/`) && createdBody.key.endsWith('.mp4'),
    JSON.stringify(createdBody),
  );

  const signed = await up('sign-part', { ...auth, body: { key: createdBody.key, uploadId: createdBody.uploadId, partNumber: 1 } });
  const signedBody = await signed.json().catch(() => ({}));
  const signedUrl = new URL(signedBody.url ?? 'http://invalid');
  check(
    'uploads: sign-part returns a presigned PUT for the stub endpoint',
    signed.status === 200 && signedUrl.searchParams.get('partNumber') === '1' &&
      signedUrl.searchParams.get('uploadId') === 'STUB-UPLOAD-ID' &&
      signedUrl.searchParams.has('X-Amz-Signature'),
    signedBody.url ?? `status ${signed.status}`,
  );

  const wrongRoom = await up('complete', { ...auth, body: { key: 'uploads/ZZZZZZ/x.mp4', uploadId: 'STUB-UPLOAD-ID', parts: [{ partNumber: 1, etag: '"abc"' }] } });
  check('uploads: complete for another room’s key -> 404', wrongRoom.status === 404, `got ${wrongRoom.status}`);

  const completed = await up('complete', {
    ...auth,
    body: { key: createdBody.key, uploadId: createdBody.uploadId, parts: [{ partNumber: 1, etag: '"abc"' }, { partNumber: 2, etag: '"def"' }] },
  });
  check('uploads: complete succeeds against the stub', completed.status === 200, `got ${completed.status}`);

  const aborted = await up('abort', { ...auth, body: { key: createdBody.key, uploadId: createdBody.uploadId } });
  check('uploads: abort succeeds', aborted.status === 200, `got ${aborted.status}`);

  const presignNow = await fetch(`${BASE}/rooms/${CODE}/files/${encodeURIComponent(createdBody.key)}/presign`, auth);
  const presignBody = await presignNow.json().catch(() => ({}));
  check(
    'uploads: uploaded key presigns for playback (stub endpoint in URL)',
    presignNow.status === 200 && typeof presignBody.url === 'string' && presignBody.url.includes(`127.0.0.1:${stubPort}`),
    `got ${presignNow.status}`,
  );
  const libraryAnon = await fetch(`${BASE}/rooms/${CODE}/library`);
  check('library: anonymous list -> 401', libraryAnon.status === 401, `got ${libraryAnon.status}`);
  const libraryWrong = await fetch(`${BASE}/rooms/${CODE}/library`, {
    headers: { 'X-Room-Session': 'f'.repeat(64) },
  });
  check('library: wrong token list -> 403', libraryWrong.status === 403, `got ${libraryWrong.status}`);

  const library = await fetch(`${BASE}/rooms/${CODE}/library`, auth);
  const libraryBody = await library.json().catch(() => ({}));
  const libraryMovie = libraryBody.movies?.find((movie) => movie.key === createdBody.key);
  check(
    'library: completed upload is listed with its original title and size',
    library.status === 200 && libraryMovie?.title === 'My Movie (2026).mp4' &&
      libraryMovie?.size === 40 * 1024 * 1024 && libraryMovie?.sourceRoom === CODE,
    JSON.stringify(libraryMovie ?? libraryBody),
  );

  // The point of the library: a *different* room can discover and play the
  // same completed upload without the file being uploaded again.
  const OTHER_CODE = CODE === 'ZZZZZZ' ? 'YYYYYY' : 'ZZZZZZ';
  const v = new Client('V'); clients.push(v);
  await v.connect(OTHER_CODE, '?name=NextNight&host=1');
  const welcomeV = await v.waitFor((m) => m.type === 'welcome', 'welcome V');
  const vAuth = { headers: { 'X-Room-Session': welcomeV.sessionToken } };
  const libraryFromNewRoom = await fetch(`${BASE}/rooms/${OTHER_CODE}/library`, vAuth);
  const libraryFromNewRoomBody = await libraryFromNewRoom.json().catch(() => ({}));
  check(
    'library: a new room can discover the previous room’s upload',
    libraryFromNewRoom.status === 200 && libraryFromNewRoomBody.movies?.some((movie) => movie.key === createdBody.key),
    `got ${libraryFromNewRoom.status}`,
  );
  const presignFromNewRoom = await fetch(
    `${BASE}/rooms/${OTHER_CODE}/files/${encodeURIComponent(createdBody.key)}/presign`,
    vAuth,
  );
  check('library: a new room can presign the reused movie', presignFromNewRoom.status === 200, `got ${presignFromNewRoom.status}`);

  const invalidDelete = await fetch(`${BASE}/rooms/${OTHER_CODE}/library/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...vAuth.headers },
    body: JSON.stringify({ key: 'movie.mp4' }),
  });
  check('library: deleting a non-library key -> 400', invalidDelete.status === 400, `got ${invalidDelete.status}`);

  const deleted = await fetch(`${BASE}/rooms/${OTHER_CODE}/library/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...vAuth.headers },
    body: JSON.stringify({ key: createdBody.key }),
  });
  check('library: manual delete succeeds', deleted.status === 200, `got ${deleted.status}`);
  const libraryAfterDelete = await fetch(`${BASE}/rooms/${OTHER_CODE}/library`, vAuth);
  const libraryAfterDeleteBody = await libraryAfterDelete.json().catch(() => ({}));
  check(
    'library: deleted movie disappears from the reusable list',
    libraryAfterDelete.status === 200 && !libraryAfterDeleteBody.movies?.some((movie) => movie.key === createdBody.key),
    `got ${libraryAfterDelete.status}`,
  );

  stubS3.close();
} catch (e) {
  check(`run completed without harness error (${e.message})`, false);
} finally {
  for (const cl of clients) cl.close();
  await stopServer();
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed (room ${CODE}, port ${PORT})`);
process.exit(failed ? 1 : 0);
