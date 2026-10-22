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
const child = spawn(
  'npx',
  ['wrangler', 'dev', '--config', 'worker/wrangler.toml', '--port', String(PORT), '--ip', '127.0.0.1'],
  { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverLog = '';
child.stdout.on('data', (d) => { serverLog = (serverLog + d).slice(-4000); });
child.stderr.on('data', (d) => { serverLog = (serverLog + d).slice(-4000); });

async function stopServer() {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already dead */ }
  await sleep(800);
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already dead */ }
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
} catch (e) {
  check(`run completed without harness error (${e.message})`, false);
} finally {
  for (const cl of clients) cl.close();
  await stopServer();
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed (room ${CODE}, port ${PORT})`);
process.exit(failed ? 1 : 0);
