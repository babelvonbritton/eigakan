/**
 * Private-R2 HLS delivery — playlist rewriting (ported from the tested
 * prototype in ~/workspace/eigakan-hls-delivery, 10/10 checks).
 *
 * Problem: a presigned R2 URL signs exactly one object. An HLS stream is a
 * tree — master.m3u8 -> rendition playlists -> .ts segments — so signing
 * only master.m3u8 leaves every child request unsigned, and a private
 * bucket refuses them.
 *
 * Design (two-level rewrite; the worker only ever serves tiny playlists):
 *
 *   1. A room member (room-session token, see index.ts) asks the worker to
 *      mint an HLS viewing URL for a prefix, e.g. "movie-hls/". The worker
 *      returns a URL on itself:
 *        /rooms/<code>/hls/<prefix>/master.m3u8?exp=<unix>&sig=<hmac>
 *      sig = HMAC-SHA256(key = R2_SECRET_ACCESS_KEY,
 *                         msg = code | key | exp). The session token itself
 *      never appears in a URL, and a URL (not a header) is what native
 *      Safari HLS requires.
 *   2. The player fetches the master playlist from the worker. The worker
 *      validates exp/sig, fetches master.m3u8 from R2 server-side, and
 *      rewrites every child URI (bare lines and URI="..." attributes,
 *      e.g. the EXT-X-MEDIA audio rendition) into a worker playlist URL
 *      carrying its own sig bound to that child key.
 *   3. A rendition playlist request is validated the same way; the worker
 *      fetches it from R2 and rewrites each segment URI into a direct
 *      presigned R2 GET URL (4 h, same bearer limit as the single-file
 *      presign route). Segments never pass through the worker.
 *
 * Signing uses Web Crypto (available natively in Workers) rather than
 * node:crypto, so this module stays runtime-idiomatic.
 */

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC signature binding a room code + object key + expiry. */
export async function signKey(
  secret: string,
  code: string,
  key: string,
  exp: number,
): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    encoder.encode(`${code}|${key}|${exp}`),
  );
  return hexEncode(new Uint8Array(signature));
}

export async function verifyKey(
  secret: string,
  code: string,
  key: string,
  exp: number,
  sig: string,
  nowSeconds: number,
): Promise<boolean> {
  if (!Number.isFinite(exp) || exp < nowSeconds) return false;
  const expected = await signKey(secret, code, key, exp);
  if (expected.length !== sig.length) return false;
  // Constant-time-ish comparison over the hex strings.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

/** Worker URL that serves the (rewritten) playlist for `key`. */
export async function workerPlaylistUrl(
  base: string,
  code: string,
  key: string,
  secret: string,
  exp: number,
): Promise<string> {
  const sig = await signKey(secret, code, key, exp);
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${base}/rooms/${code}/hls/${encodedKey}?exp=${exp}&sig=${sig}`;
}

const URI_ATTR = /URI="([^"]+)"/g;

function isPlaylistRef(uri: string): boolean {
  return uri.endsWith('.m3u8');
}

function resolveKey(playlistKey: string, uri: string): string {
  // Playlists reference children relative to their own directory.
  const dir = playlistKey.slice(0, playlistKey.lastIndexOf('/') + 1);
  return dir + uri;
}

/**
 * Rewrite a master playlist: every referenced playlist (rendition lines
 * and URI="..." attributes such as EXT-X-MEDIA audio) becomes a signed
 * worker playlist URL. Non-playlist lines pass through untouched.
 */
export async function rewriteMaster(
  text: string,
  opts: { base: string; code: string; masterKey: string; secret: string; exp: number },
): Promise<string> {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && isPlaylistRef(trimmed)) {
      out.push(
        await workerPlaylistUrl(
          opts.base,
          opts.code,
          resolveKey(opts.masterKey, trimmed),
          opts.secret,
          opts.exp,
        ),
      );
      continue;
    }
    // Tag lines: rewrite any playlist URI="..." attribute (async, sequential).
    let rewritten = line;
    const matches = [...line.matchAll(URI_ATTR)];
    for (const match of matches) {
      const uri = match[1];
      if (isPlaylistRef(uri)) {
        const url = await workerPlaylistUrl(
          opts.base,
          opts.code,
          resolveKey(opts.masterKey, uri),
          opts.secret,
          opts.exp,
        );
        rewritten = rewritten.replace(match[0], `URI="${url}"`);
      }
    }
    out.push(rewritten);
  }
  return out.join('\n');
}

/**
 * Rewrite a rendition playlist: every segment URI (bare lines and
 * URI="..." attributes such as EXT-X-MAP) becomes a direct presigned R2
 * URL produced by `presign(key)`. Tag lines otherwise pass through.
 */
export async function rewriteRendition(
  text: string,
  opts: { renditionKey: string; presign: (key: string) => Promise<string> },
): Promise<string> {
  const dir = opts.renditionKey.slice(0, opts.renditionKey.lastIndexOf('/') + 1);
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      out.push(await opts.presign(dir + trimmed));
      continue;
    }
    let rewritten = line;
    const matches = [...line.matchAll(URI_ATTR)];
    for (const match of matches) {
      const uri = match[1];
      if (!uri.startsWith('http')) {
        const url = await opts.presign(dir + uri);
        rewritten = rewritten.replace(match[0], `URI="${url}"`);
      }
    }
    out.push(rewritten);
  }
  return out.join('\n');
}

/** True when a playlist text is a master playlist (has variant/media tags). */
export function isMasterPlaylist(text: string): boolean {
  return text.includes('#EXT-X-STREAM-INF') || text.includes('#EXT-X-MEDIA');
}
