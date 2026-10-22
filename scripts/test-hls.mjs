#!/usr/bin/env node
/**
 * Tests for worker/src/hls.ts — the integrated private-R2 HLS rewriting
 * core (async Web Crypto port of the prototype that passed 10/10 in
 * ~/workspace/eigakan-hls-delivery). Fixtures use the exact shape
 * scripts/encode-hls.sh produces: master.m3u8 with 720p/480p/360p
 * renditions plus an audio rendition, rendition playlists of seg_*.ts.
 *
 * Run: npm run test:hls   (imports the .ts module via Node type stripping)
 */
import assert from 'node:assert/strict';
import { rewriteMaster, rewriteRendition, signKey, verifyKey, workerPlaylistUrl } from '../worker/src/hls.ts';

const SECRET = 'test-secret-not-a-real-credential';
const CODE = 'ABC234';
const EXP = 2_000_000_000; // fixed future expiry for determinism
const BASE = 'https://eigakan-room.example.workers.dev';

let passed = 0;
async function check(label, fn) {
  await fn();
  passed += 1;
  console.log(`PASS  ${label}`);
}

// --- signature binding -------------------------------------------------
await check('sig verifies for its own code/key/exp', async () => {
  const sig = await signKey(SECRET, CODE, 'movie-hls/master.m3u8', EXP);
  assert.equal(await verifyKey(SECRET, CODE, 'movie-hls/master.m3u8', EXP, sig, 1_900_000_000), true);
});
await check('sig fails for another prefix (tampered path)', async () => {
  const sig = await signKey(SECRET, CODE, 'movie-hls/master.m3u8', EXP);
  assert.equal(await verifyKey(SECRET, CODE, 'other-movie/master.m3u8', EXP, sig, 1_900_000_000), false);
});
await check('sig fails for another room code', async () => {
  const sig = await signKey(SECRET, CODE, 'movie-hls/master.m3u8', EXP);
  assert.equal(await verifyKey(SECRET, 'XYZ999', 'movie-hls/master.m3u8', EXP, sig, 1_900_000_000), false);
});
await check('sig fails after expiry', async () => {
  const sig = await signKey(SECRET, CODE, 'movie-hls/master.m3u8', EXP);
  assert.equal(await verifyKey(SECRET, CODE, 'movie-hls/master.m3u8', EXP, sig, EXP + 1), false);
});

// --- master rewrite ------------------------------------------------------
const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",DEFAULT=YES,URI="audio/playlist.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2928000,RESOLUTION=1280x720,AUDIO="audio"
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1328000,RESOLUTION=854x480,AUDIO="audio"
480p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=828000,RESOLUTION=640x360,AUDIO="audio"
360p/playlist.m3u8
`;

const rewrittenMaster = await rewriteMaster(MASTER, {
  base: BASE,
  code: CODE,
  masterKey: 'movie-hls/master.m3u8',
  secret: SECRET,
  exp: EXP,
});

await check('master: all 3 rendition lines become signed worker URLs', async () => {
  for (const r of ['720p', '480p', '360p']) {
    const expected = await workerPlaylistUrl(BASE, CODE, `movie-hls/${r}/playlist.m3u8`, SECRET, EXP);
    assert.ok(rewrittenMaster.includes(`\n${expected}\n`) || rewrittenMaster.includes(`\n${expected}`), r);
  }
});
await check('master: EXT-X-MEDIA audio URI is rewritten too', async () => {
  const expected = await workerPlaylistUrl(BASE, CODE, 'movie-hls/audio/playlist.m3u8', SECRET, EXP);
  assert.ok(rewrittenMaster.includes(`URI="${expected}"`));
});
await check('master: no bare .m3u8 reference survives', async () => {
  for (const line of rewrittenMaster.split('\n')) {
    const t = line.trim();
    assert.ok(!t.endsWith('.m3u8'), `bare playlist line leaked: ${t}`);
  }
  assert.ok(!/URI="(?!https:)[^"]+\.m3u8"/.test(rewrittenMaster));
});
await check('master: stream-inf tags and version untouched', async () => {
  assert.ok(rewrittenMaster.includes('#EXT-X-STREAM-INF:BANDWIDTH=2928000,RESOLUTION=1280x720'));
  assert.ok(rewrittenMaster.startsWith('#EXTM3U'));
});

// --- rendition rewrite ---------------------------------------------------
const RENDITION = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:6.006,
seg_00000.ts
#EXTINF:6.006,
seg_00001.ts
#EXT-X-ENDLIST
`;

const presign = async (key) => `https://acct.r2.cloudflarestorage.com/bucket/${key}?X-Amz-Signature=STUB`;
const rewrittenRendition = await rewriteRendition(RENDITION, { renditionKey: 'movie-hls/720p/playlist.m3u8', presign });

await check('rendition: segments become presigned R2 URLs under the rendition dir', async () => {
  assert.ok(rewrittenRendition.includes('https://acct.r2.cloudflarestorage.com/bucket/movie-hls/720p/seg_00000.ts?X-Amz-Signature=STUB'));
  assert.ok(rewrittenRendition.includes('https://acct.r2.cloudflarestorage.com/bucket/movie-hls/720p/seg_00001.ts?X-Amz-Signature=STUB'));
});
await check('rendition: no bare segment reference survives, tags untouched', async () => {
  for (const line of rewrittenRendition.split('\n')) {
    assert.ok(!line.trim().endsWith('.ts'), `bare segment leaked: ${line}`);
  }
  assert.ok(rewrittenRendition.includes('#EXT-X-ENDLIST'));
});

console.log(`\n${passed}/10 checks passed`);
