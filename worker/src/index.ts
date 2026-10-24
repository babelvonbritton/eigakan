import {
  MAX_PEERS_PER_ROOM,
  normalizeRoomCode,
  type ClientMessage,
  type ServerMessage,
} from '@eigakan/sync-core';
import { AwsClient } from 'aws4fetch';
import { isMasterPlaylist, rewriteMaster, rewriteRendition, signKey, verifyKey } from './hls';

/**
 * Eigakan room gateway + room object.
 *
 * Routes:
 *   GET  /rooms/:code/ws        WebSocket upgrade, forwarded to the room's Durable Object
 *   GET  /rooms/:code/files/:key/presign   Short-lived R2 GET URL — gated: requires the
 *                                           room-session token issued on WebSocket join
 *                                           (header `X-Room-Session` or `Authorization: Bearer …`)
 *   POST /rooms/:code/uploads/*           Gated (same token): S3 multipart upload brokering
 *                                           (create / sign-part / complete / abort) for the
 *                                           in-site movie uploader; bytes flow browser→R2
 *   GET  /rooms/:code/library             Gated (same token): completed in-site uploads
 *                                           across all rooms, for reuse in a later room
 *   POST /rooms/:code/library/delete      Gated (same token): remove one library movie
 *   GET  /rooms/:code/hls/:prefix/mint     Gated (same token): mints a signed worker HLS
 *                                           URL for <prefix>master.m3u8 (4h expiry)
 *   GET  /rooms/:code/hls/:key.m3u8?exp&sig  Serves a rewritten HLS playlist: master
 *                                           children become signed worker URLs, rendition
 *                                           segments become direct presigned R2 URLs
 *   GET  /health                Liveness probe
 *
 * The Durable Object is the single authority for a room: it enforces the
 * two-viewer rule *server-side* and relays playback events between the two
 * sockets. It uses the WebSocket Hibernation API so an idle room costs no
 * duration billing between messages.
 */
/** Random per-join session token (32 bytes, hex). Shown once, in `welcome`. */
function newSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface SocketAttachment {
  peerId: string;
  sessionToken: string;
  /** Display name chosen before entering (not an account — a room label). */
  name: string;
  /** The room's creator; only the host may terminate the room for everyone. */
  isHost: boolean;
}

/** Sanitize a self-chosen display name: trimmed, capped, fallback provided. */
function sanitizeDisplayName(raw: string | null): string {
  const clean = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return clean || 'Guest';
}

export class Room implements DurableObject {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal check, called only by the gateway Worker (never routed from
    // the public API): is this session token held by a live peer in the room?
    // The token lives in the socket attachment, so it dies with the socket —
    // presign access ends when the viewer leaves the room.
    if (url.pathname === '/presign-check') {
      const presented = request.headers.get('X-Room-Session') ?? '';
      const ok =
        presented.length > 0 &&
        this.state.getWebSockets().some((peer) => {
          try {
            const attachment = peer.deserializeAttachment() as SocketAttachment | null;
            return attachment?.sessionToken === presented;
          } catch {
            return false;
          }
        });
      return Response.json({ ok }, { status: ok ? 200 : 403 });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }

    const peers = this.state.getWebSockets();
    if (peers.length >= MAX_PEERS_PER_ROOM) {
      const pair = new WebSocketPair();
      const client = pair[1];
      client.accept();
      const full: ServerMessage = { type: 'room-full' };
      client.send(JSON.stringify(full));
      client.close(4001, 'Room is full');
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Hibernation API: the socket survives while this object sleeps, and the
    // runtime wakes the object only when a message actually arrives.
    this.state.acceptWebSocket(server);

    const peerId = crypto.randomUUID();
    const sessionToken = newSessionToken();
    const name = sanitizeDisplayName(url.searchParams.get('name'));
    const isHost = url.searchParams.get('host') === '1';
    server.serializeAttachment({ peerId, sessionToken, name, isHost } satisfies SocketAttachment);

    const welcome: ServerMessage = {
      type: 'welcome',
      peerId,
      peers: this.state.getWebSockets().length,
      sessionToken,
    };
    server.send(JSON.stringify(welcome));
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== 'string') return;
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      const error: ServerMessage = { type: 'error', message: 'Invalid JSON message' };
      ws.send(JSON.stringify(error));
      return;
    }

    const serverReceivedAt = Date.now();
    let outbound: ServerMessage | null = null;
    switch (message.type) {
      case 'event':
        outbound = { type: 'peer-event', event: message.event, serverReceivedAt };
        break;
      case 'heartbeat':
        outbound = { type: 'peer-heartbeat', heartbeat: message.heartbeat, serverReceivedAt };
        break;
      case 'chat': {
        // Keep chat minimal: plain text, capped, stamped with the sender's
        // display name so the partner sees who said it.
        let senderName = 'Guest';
        try {
          const att = ws.deserializeAttachment() as SocketAttachment | null;
          if (att?.name) senderName = att.name;
        } catch { /* keep fallback */ }
        outbound = {
          type: 'peer-chat',
          text: String(message.text).slice(0, 500),
          name: senderName,
          serverReceivedAt,
        };
        break;
      }
      case 'end-room': {
        // Host-only room termination: notify everyone, then close every
        // socket. With no live sockets the room ceases to exist, and the
        // session tokens die with them.
        let isHost = false;
        try {
          const att = ws.deserializeAttachment() as SocketAttachment | null;
          isHost = att?.isHost === true;
        } catch { /* not host */ }
        if (!isHost) return;
        const ended = JSON.stringify({ type: 'room-ended' } satisfies ServerMessage);
        for (const peer of this.state.getWebSockets()) {
          try { peer.send(ended); } catch { /* closing anyway */ }
          try { peer.close(1000, 'Room ended by the host'); } catch { /* already gone */ }
        }
        return;
      }
    }
    if (!outbound) return;

    const payload = JSON.stringify(outbound);
    for (const peer of this.state.getWebSockets()) {
      if (peer !== ws) {
        try {
          peer.send(payload);
        } catch {
          // A dead peer will be pruned by webSocketClose/error.
        }
      }
    }
  }

  webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    this.broadcastPresence();
  }

  webSocketError(_ws: WebSocket, _error: unknown): void {
    this.broadcastPresence();
  }

  private broadcastPresence(): void {
    const peers = this.state.getWebSockets();
    const entries = peers.map((peer) => {
      let name = 'Guest';
      let isHost = false;
      try {
        const att = peer.deserializeAttachment() as SocketAttachment | null;
        if (att?.name) name = att.name;
        isHost = att?.isHost === true;
      } catch {
        // Keep the fallbacks above.
      }
      return { peer, name, isHost };
    });
    const names = entries.map((entry) => entry.name);
    // Personalized per recipient so each viewer can tell which person is
    // themself (two viewers may even share a display name).
    for (const recipient of peers) {
      const message: ServerMessage = {
        type: 'presence',
        peers: peers.length,
        names,
        people: entries.map((entry) => ({
          name: entry.name,
          isHost: entry.isHost,
          isYou: entry.peer === recipient,
        })),
      };
      try {
        recipient.send(JSON.stringify(message));
      } catch {
        // Ignore; close handler will reconcile.
      }
    }
  }
}

/** Encode an R2 object key for a URL path: slashes stay slashes, each segment is escaped. */
function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function r2Client(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
    service: 's3',
    region: 'auto',
  });
}

function r2ObjectUrl(env: Env, key: string): URL {
  const base = env.R2_ENDPOINT ?? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return new URL(`${base}/${env.R2_BUCKET}/${encodeKeyPath(key)}`);
}

function r2BucketUrl(env: Env): URL {
  const base = env.R2_ENDPOINT ?? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return new URL(`${base}/${env.R2_BUCKET}`);
}

function r2Configured(env: Env): boolean {
  return Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET);
}

/** Presigned R2 GET URL (default 4h — a movie plus buffer). */
async function presignR2Get(env: Env, key: string, expiresSeconds = 4 * 60 * 60): Promise<string> {
  const url = r2ObjectUrl(env, key);
  url.searchParams.set('X-Amz-Expires', String(expiresSeconds));
  const signed = await r2Client(env).sign(new Request(url, { method: 'GET' }), {
    aws: { signQuery: true },
  });
  return signed.url;
}

/** Presigned R2 PUT URL for one part of a multipart upload (2h session). */
async function presignR2Part(
  env: Env,
  key: string,
  uploadId: string,
  partNumber: number,
): Promise<string> {
  const url = r2ObjectUrl(env, key);
  url.searchParams.set('partNumber', String(partNumber));
  url.searchParams.set('uploadId', uploadId);
  url.searchParams.set('X-Amz-Expires', String(2 * 60 * 60));
  const signed = await r2Client(env).sign(new Request(url, { method: 'PUT' }), {
    aws: { signQuery: true },
  });
  return signed.url;
}

/** Execute a small signed S3 call server-side (multipart create/complete/abort — bodies are tiny XML). */
async function r2S3Call(
  env: Env,
  key: string,
  method: string,
  query: Record<string, string>,
  body?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const url = r2ObjectUrl(env, key);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const headers = { ...extraHeaders, ...(body ? { 'Content-Type': 'application/xml' } : {}) };
  const signed = await r2Client(env).sign(
    new Request(url, {
      method,
      body,
      headers: Object.keys(headers).length ? headers : undefined,
    }),
  );
  return fetch(signed);
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface UploadedMovie {
  key: string;
  title: string;
  size: number;
  /** ISO timestamp from ListObjects (the multipart completion time). */
  uploadedAt: string;
  /** Room in which the movie was originally uploaded; the library spans rooms. */
  sourceRoom: string;
}

function xmlUnescape(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|lt|gt|quot|apos|amp);/g, (_match, entity: string) => {
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    if (entity === 'amp') return '&';
    const codePoint = entity.startsWith('#x') || entity.startsWith('#X')
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _match;
  });
}

function xmlTagText(block: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return match ? xmlUnescape(match[1]) : '';
}

/** S3 object metadata values must be header-safe; carry the original filename as base64url UTF-8. */
function encodeTitleMetadata(title: string): string {
  const bytes = new TextEncoder().encode(title.slice(0, 180));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeTitleMetadata(value: string): string | null {
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const title = new TextDecoder().decode(bytes).trim();
    return title || null;
  } catch {
    return null;
  }
}

function titleFromUploadKey(key: string): string {
  const filename = key.split('/').pop() ?? 'Uploaded movie';
  return filename.replace(/^[0-9a-f]{8}-/i, '') || 'Uploaded movie';
}

async function fetchR2ObjectTitle(env: Env, key: string): Promise<string | null> {
  try {
    const signed = await r2Client(env).sign(new Request(r2ObjectUrl(env, key), { method: 'HEAD' }));
    const res = await fetch(signed);
    if (!res.ok) return null;
    const encoded = res.headers.get('x-amz-meta-title');
    return encoded ? decodeTitleMetadata(encoded) : null;
  } catch {
    return null;
  }
}

/**
 * List completed in-site uploads across every room namespace. Multipart
 * uploads do not appear in ListObjects until they complete, so abandoned
 * sessions and individual parts never pollute the library.
 */
async function listUploadedMovies(env: Env): Promise<UploadedMovie[]> {
  const movies: UploadedMovie[] = [];
  let continuationToken = '';

  for (let page = 0; page < 10; page++) {
    const url = r2BucketUrl(env);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', 'uploads/');
    url.searchParams.set('max-keys', '1000');
    if (continuationToken) url.searchParams.set('continuation-token', continuationToken);

    const signed = await r2Client(env).sign(new Request(url, { method: 'GET' }));
    const res = await fetch(signed);
    if (!res.ok) throw new Error(`R2 list failed (${res.status})`);
    const text = await res.text();

    for (const match of text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = match[1];
      const key = xmlTagText(block, 'Key');
      const segments = key.split('/');
      if (segments.length !== 3 || segments[0] !== 'uploads' || !segments[1] || !segments[2]) continue;
      if (!/\.(mp4|m4v|webm)$/i.test(segments[2])) continue;
      const size = Number(xmlTagText(block, 'Size'));
      if (!Number.isFinite(size) || size <= 0) continue;
      movies.push({
        key,
        title: titleFromUploadKey(key),
        size,
        uploadedAt: xmlTagText(block, 'LastModified'),
        sourceRoom: segments[1],
      });
    }

    const truncated = xmlTagText(text, 'IsTruncated') === 'true';
    continuationToken = xmlTagText(text, 'NextContinuationToken');
    if (!truncated || !continuationToken) break;
  }

  movies.sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt));
  const newest = movies.slice(0, 100);

  // ListObjects has no object metadata, so resolve original filenames with
  // small HEAD requests. The library is intentionally capped and this is a
  // two-person site; fall back to the key-derived title on any failure.
  for (let i = 0; i < newest.length; i += 10) {
    const batch = newest.slice(i, i + 10);
    await Promise.all(batch.map(async (movie) => {
      movie.title = (await fetchR2ObjectTitle(env, movie.key)) ?? movie.title;
    }));
  }
  return newest;
}

function isLibraryKey(key: string): boolean {
  const segments = key.split('/');
  return (
    segments.length === 3 &&
    segments[0] === 'uploads' &&
    Boolean(segments[1]) &&
    Boolean(segments[2]) &&
    !key.includes('..') &&
    /\.(mp4|m4v|webm)$/i.test(segments[2])
  );
}

/** Fetch a small R2 object (an HLS playlist) server-side with a signed GET. */
async function fetchR2Text(env: Env, key: string): Promise<string | null> {
  const signed = await r2Client(env).sign(new Request(r2ObjectUrl(env, key), { method: 'GET' }));
  const res = await fetch(signed);
  if (!res.ok) return null;
  return res.text();
}

const HLS_EXPIRY_SECONDS = 4 * 60 * 60;

/**
 * Room-session gate shared by the presign and HLS-mint routes.
 * Returns an error Response (401 missing token, 403 invalid token), or
 * null when the caller is a live member of this room.
 */
async function roomSessionGate(
  request: Request,
  room: DurableObjectStub,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  const sessionToken =
    request.headers.get('X-Room-Session') ??
    request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ??
    '';
  if (!sessionToken) {
    return Response.json(
      { error: 'Missing room session. Join the room first, then request the file from inside it.' },
      { status: 401, headers: corsHeaders },
    );
  }
  const check = await room.fetch(
    new Request('https://room.internal/presign-check', {
      headers: { 'X-Room-Session': sessionToken },
    }),
  );
  if (!check.ok) {
    return Response.json(
      { error: 'Room session is not valid for this room (expired or for a different room).' },
      { status: 403, headers: corsHeaders },
    );
  }
  return null;
}

function r2NotConfigured(corsHeaders: Record<string, string>): Response {
  return Response.json(
    { error: 'R2 is not configured on this worker yet. Set the R2_* secrets to enable movie file delivery.' },
    { status: 501, headers: corsHeaders },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // The web app is served from a different origin (Pages), so the HTTP
    // routes answer CORS. WebSocket upgrades are not subject to CORS.
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Room-Session',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'eigakan-room' }, { headers: corsHeaders });
    }

    const roomMatch = url.pathname.match(/^\/rooms\/([^/]+)(\/.*)?$/);
    if (roomMatch) {
      const code = normalizeRoomCode(roomMatch[1]);
      if (!code) return new Response('Invalid room code', { status: 400 });
      const rest = roomMatch[2] ?? '';

      const id = env.ROOMS.idFromName(code);
      const room = env.ROOMS.get(id);

      if (rest === '/ws') {
        return room.fetch(request);
      }

      if (rest.startsWith('/files/') && rest.endsWith('/presign')) {
        const key = decodeURIComponent(rest.slice('/files/'.length, -'/presign'.length));
        if (!key || key.includes('..')) return new Response('Invalid key', { status: 400 });

        // Room-session gate: only a viewer currently joined to this room may
        // obtain a signed URL. The token was issued by the Room object in its
        // `welcome` message and is validated against its live sockets, so
        // knowing the room code + file key alone is no longer enough.
        const gateError = await roomSessionGate(request, room, corsHeaders);
        if (gateError) return gateError;

        if (!r2Configured(env)) return r2NotConfigured(corsHeaders);
        const presignedUrl = await presignR2Get(env, key);
        return Response.json(
          { url: presignedUrl, expiresInSeconds: 4 * 60 * 60 },
          { headers: corsHeaders },
        );
      }

      if (rest === '/library' || rest === '/library/delete') {
        // Reusable uploads library. The current room session is the gate,
        // but the listing intentionally spans uploads/<any-room>/… — on
        // this private two-person site, a completed movie remains available
        // to later rooms until the bucket lifecycle expires it or someone
        // deletes it here.
        const gateError = await roomSessionGate(request, room, corsHeaders);
        if (gateError) return gateError;
        if (!r2Configured(env)) return r2NotConfigured(corsHeaders);

        if (rest === '/library') {
          if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
          try {
            const movies = await listUploadedMovies(env);
            return Response.json({ movies }, { headers: corsHeaders });
          } catch {
            return Response.json(
              { error: 'Could not list uploaded movies from R2.' },
              { status: 502, headers: corsHeaders },
            );
          }
        }

        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        const key = typeof body?.key === 'string' ? body.key : '';
        if (!isLibraryKey(key)) {
          return Response.json({ error: 'That is not an uploaded-library movie key.' }, { status: 400, headers: corsHeaders });
        }
        const res = await r2S3Call(env, key, 'DELETE', {});
        if (!res.ok && res.status !== 404) {
          return Response.json({ error: 'R2 refused to delete that movie.' }, { status: 502, headers: corsHeaders });
        }
        return Response.json({ ok: true, key }, { headers: corsHeaders });
      }

      if (rest === '/uploads/create' || rest === '/uploads/sign-part' || rest === '/uploads/complete' || rest === '/uploads/abort') {
        // In-site movie uploads: the browser sends file bytes straight to R2
        // with presigned part URLs; the worker only brokers the S3 multipart
        // session. Same room-session gate as presign — only a joined viewer
        // of THIS room may upload into it, and keys are namespaced by room.
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
        const gateError = await roomSessionGate(request, room, corsHeaders);
        if (gateError) return gateError;
        if (!r2Configured(env)) return r2NotConfigured(corsHeaders);

        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body) return Response.json({ error: 'Invalid JSON body.' }, { status: 400, headers: corsHeaders });
        const keyPrefix = `uploads/${code}/`;
        const givenKey = typeof body.key === 'string' ? body.key : '';
        const givenUploadId = typeof body.uploadId === 'string' ? body.uploadId : '';

        if (rest === '/uploads/create') {
          const filename = typeof body.filename === 'string' ? body.filename : '';
          const size = typeof body.size === 'number' ? body.size : NaN;
          const base = filename.split(/[\\/]/).pop() ?? '';
          const safeName = base.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-80) || 'movie';
          const ext = (safeName.split('.').pop() ?? '').toLowerCase();
          const contentTypes: Record<string, string> = {
            mp4: 'video/mp4',
            m4v: 'video/x-m4v',
            webm: 'video/webm',
          };
          if (!contentTypes[ext]) {
            return Response.json(
              { error: 'Only browser-playable files can be uploaded in the site: .mp4, .m4v or .webm.' },
              { status: 415, headers: corsHeaders },
            );
          }
          if (!Number.isFinite(size) || size <= 0 || size > 5 * 1024 * 1024 * 1024) {
            return Response.json({ error: 'File must be between 1 byte and 5 GiB.' }, { status: 413, headers: corsHeaders });
          }
          const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
            b.toString(16).padStart(2, '0'),
          ).join('');
          const key = `${keyPrefix}${rand}-${safeName}`;
          const res = await r2S3Call(env, key, 'POST', { uploads: '' }, undefined, {
            'Content-Type': contentTypes[ext],
            // The reusable library shows the viewer's original filename,
            // not the deliberately sanitized object-key suffix.
            'x-amz-meta-title': encodeTitleMetadata(base),
          });
          const text = await res.text();
          const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(text)?.[1];
          if (!res.ok || !uploadId) {
            return Response.json({ error: 'R2 refused to start the upload.' }, { status: 502, headers: corsHeaders });
          }
          return Response.json({ key, uploadId }, { headers: corsHeaders });
        }

        // The remaining operations act on an upload this room started.
        if (!givenKey.startsWith(keyPrefix) || !givenUploadId) {
          return Response.json({ error: 'Unknown upload for this room.' }, { status: 404, headers: corsHeaders });
        }

        if (rest === '/uploads/sign-part') {
          const partNumber = typeof body.partNumber === 'number' ? body.partNumber : NaN;
          if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
            return Response.json({ error: 'Invalid part number.' }, { status: 400, headers: corsHeaders });
          }
          const url = await presignR2Part(env, givenKey, givenUploadId, partNumber);
          return Response.json({ url }, { headers: corsHeaders });
        }

        if (rest === '/uploads/complete') {
          const parts = Array.isArray(body.parts) ? body.parts : [];
          const clean = parts
            .filter(
              (p): p is { partNumber: number; etag: string } =>
                typeof p === 'object' && p !== null &&
                typeof (p as { partNumber?: unknown }).partNumber === 'number' &&
                typeof (p as { etag?: unknown }).etag === 'string',
            )
            .sort((a, b) => a.partNumber - b.partNumber);
          if (clean.length === 0) {
            return Response.json({ error: 'No uploaded parts to complete.' }, { status: 400, headers: corsHeaders });
          }
          const xml =
            '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
            clean.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`).join('') +
            '</CompleteMultipartUpload>';
          const res = await r2S3Call(env, givenKey, 'POST', { uploadId: givenUploadId }, xml);
          const text = await res.text();
          if (!res.ok || text.includes('<Error>')) {
            return Response.json({ error: 'R2 refused to finish the upload.' }, { status: 502, headers: corsHeaders });
          }
          return Response.json({ ok: true, key: givenKey }, { headers: corsHeaders });
        }

        // /uploads/abort
        await r2S3Call(env, givenKey, 'DELETE', { uploadId: givenUploadId }).catch(() => null);
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      if (rest.startsWith('/hls/')) {
        const hlsPath = rest
          .slice('/hls/'.length)
          .split('/')
          .map((segment) => decodeURIComponent(segment))
          .join('/');

        // Mint: a live room member exchanges their session token for a
        // signed worker URL for <prefix>master.m3u8. The token never
        // appears in a URL; the HMAC sig (bound to room + key + expiry)
        // is what travels, which native Safari HLS requires.
        if (hlsPath.endsWith('/mint')) {
          const prefix = hlsPath.slice(0, -'/mint'.length).replace(/^\/+|\/+$/g, '');
          if (!prefix || prefix.includes('..')) return new Response('Invalid prefix', { status: 400 });
          const gateError = await roomSessionGate(request, room, corsHeaders);
          if (gateError) return gateError;
          if (!r2Configured(env)) return r2NotConfigured(corsHeaders);
          const masterKey = `${prefix}/master.m3u8`;
          const exp = Math.floor(Date.now() / 1000) + HLS_EXPIRY_SECONDS;
          const sig = await signKey(env.R2_SECRET_ACCESS_KEY ?? '', code, masterKey, exp);
          const base = `${url.protocol}//${url.host}`;
          const encodedKey = masterKey.split('/').map(encodeURIComponent).join('/');
          return Response.json(
            {
              url: `${base}/rooms/${code}/hls/${encodedKey}?exp=${exp}&sig=${sig}`,
              expiresInSeconds: HLS_EXPIRY_SECONDS,
            },
            { headers: corsHeaders },
          );
        }

        // Playlist serving: validated by the HMAC sig alone (players cannot
        // send headers). Master playlists are rewritten to signed worker
        // URLs; rendition playlists to direct presigned R2 segment URLs.
        if (hlsPath.endsWith('.m3u8')) {
          const key = hlsPath;
          if (!key || key.includes('..')) return new Response('Invalid key', { status: 400 });
          if (!r2Configured(env)) return r2NotConfigured(corsHeaders);
          const exp = Number(url.searchParams.get('exp') ?? '');
          const sig = url.searchParams.get('sig') ?? '';
          const nowSeconds = Math.floor(Date.now() / 1000);
          const valid = await verifyKey(env.R2_SECRET_ACCESS_KEY ?? '', code, key, exp, sig, nowSeconds);
          if (!valid) {
            return Response.json(
              { error: 'HLS link is invalid or expired. Mint a fresh one from inside the room.' },
              { status: 403, headers: corsHeaders },
            );
          }
          const text = await fetchR2Text(env, key);
          if (text === null) return new Response('Playlist not found in R2', { status: 404, headers: corsHeaders });
          const base = `${url.protocol}//${url.host}`;
          const secret = env.R2_SECRET_ACCESS_KEY ?? '';
          const rewritten = isMasterPlaylist(text)
            ? await rewriteMaster(text, { base, code, masterKey: key, secret, exp })
            : await rewriteRendition(text, {
                renditionKey: key,
                presign: (segmentKey) => presignR2Get(env, segmentKey, Math.max(60, exp - nowSeconds)),
              });
          return new Response(rewritten, {
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/vnd.apple.mpegurl',
              'Cache-Control': 'no-store',
            },
          });
        }

        return new Response('Not found', { status: 404 });
      }

      return new Response('Not found', { status: 404 });
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
