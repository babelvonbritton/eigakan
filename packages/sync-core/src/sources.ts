import type { VideoSource } from './protocol';

/** Alphabet without look-alikes (no 0/O, 1/I/L) so codes survive being read aloud. */
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

export function generateRoomCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

export function normalizeRoomCode(input: string): string | null {
  const code = input.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) {
    if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  }
  return code;
}

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** Extract a YouTube video id from a watch/shorts/live/embed URL or a bare id. */
export function parseYouTubeVideoId(input: string): string | null {
  const text = input.trim();
  if (YOUTUBE_ID_PATTERN.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0] ?? '';
    return YOUTUBE_ID_PATTERN.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') {
      const id = url.searchParams.get('v') ?? '';
      return YOUTUBE_ID_PATTERN.test(id) ? id : null;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if ((parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed') && parts[1]) {
      return YOUTUBE_ID_PATTERN.test(parts[1]) ? parts[1] : null;
    }
  }
  return null;
}

/**
 * Classify a user-pasted source into a VideoSource.
 * Returns null for anything we cannot play together.
 */
export function parseVideoSource(input: string): VideoSource | null {
  const text = input.trim();
  if (!text) return null;
  const youtubeId = parseYouTubeVideoId(text);
  if (youtubeId) return { kind: 'youtube', ref: youtubeId };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (/\.m3u8($|\?)/i.test(url.pathname + url.search)) {
    return { kind: 'hls', ref: url.toString() };
  }
  if (/\.mp4($|\?)/i.test(url.pathname + url.search)) {
    return { kind: 'mp4', ref: url.toString() };
  }
  // Signed URLs (e.g. R2/S3 presigned) often have no .mp4 suffix in the path.
  // Accept them as MP4 when the caller explicitly points at an object store
  // host pattern; otherwise require the suffix so we do not feed HTML pages
  // to the <video> element.
  if (/r2\.dev|r2\.cloudflarestorage\.com|\.s3[.-]/i.test(url.hostname)) {
    return { kind: 'mp4', ref: url.toString() };
  }
  return null;
}

/** Local files never enter a VideoSource URL — the ref is just a display name. */
export function localFileSource(fileName: string): VideoSource {
  return { kind: 'local-file', ref: fileName };
}
