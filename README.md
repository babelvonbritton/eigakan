# EIGAKAN — Watch Together, For Two

A two-person watch-together room. One of you creates a room, the other joins
with a 6-character code — and the room is **locked at exactly two viewers,
enforced on the server**. Play, pause, seek and playback rate stay in sync
across both screens for:

- **YouTube** links (IFrame Player API)
- **MP4 URLs** (e.g. a private, expiring link to your own object storage)
- **HLS streams** (`.m3u8` master playlists) with adaptive bitrate via
  hls.js / native Safari HLS — see `scripts/encode-hls.sh`
- **Local files** — both viewers pick the same file on their own device; the
  file never leaves either machine, only the controls travel

If either viewer stalls, the room **pauses for both** and resumes together
when the stalled player recovers — nobody drifts ahead alone.

The UI is a Netflix-inspired cinematic layout restyled in black and a
luxurious amber / burnt-orange palette.

## Architecture

| Piece | What it is |
|---|---|
| `web/` | Static Astro + TypeScript site (landing + room pages). Deploys to Cloudflare Pages. |
| `worker/` | Cloudflare Worker + one **Durable Object per room** (SQLite-backed, Free-plan friendly). Enforces max-2 over hibernating WebSockets and relays sync events. Also generates short-lived **R2 presigned URLs**. |
| `packages/sync-core/` | Shared TypeScript package: the wire protocol, latency compensation and drift-correction math, room-code and source parsing. Unit-tested with Vitest. |

How sync works: events carry the sender's playhead position and send time;
the receiver projects the position forward by the message transit time
before applying it. A heartbeat every 4 s feeds drift correction — small
gaps are closed with a temporary playback-rate nudge, gaps over ~1.5 s
(e.g. after buffering) with a seek.

Video data never passes through Eigakan: YouTube and MP4 hosts stream
directly to each viewer, and local files stay on-device. Eigakan only moves
tiny control messages.

## Run it locally

```bash
npm install
npm run dev
```

One command does it all: it builds sync-core, then runs the room worker
(http://localhost:8787) and the web app (http://localhost:4321) side by side
with labeled logs (`[worker]` / `[web]`). One Ctrl+C stops both.

If you ever want the servers in separate terminals instead (each with its
own logs, and Ctrl+C killing only that one):

```bash
npm run build:core          # sync-core is consumed as built output
npm run dev:worker          # terminal 1 — room worker on http://localhost:8787
npm run dev:web             # terminal 2 — web app on http://localhost:4321
```

Open the site twice (two browsers or one incognito window), create a room in
one, join with the code in the other, load a video, press play.

## Verify

```bash
npm run verify   # typecheck (core, web, worker) + unit tests + production build
```

Worker end-to-end smoke test (boots a real `wrangler dev` on port 8789 and
drives it with two WebSocket viewers — relay, presence, room-full for a
third viewer, seat freeing on leave, and the v0.3.0 room-session gate on
the presign and HLS-mint routes; 21 checks):

```bash
npm run test:e2e:worker
npm run test:hls   # 10 playlist-rewriting checks for private-R2 HLS
```

Run them before a deployment or release; the e2e is deliberately not part
of `verify`/CI because it starts a live dev server. For the full two-browser
movie-night scenario on top of this, see `DEPLOY-CHECKLIST.md` Step 3.

## Deploy (Cloudflare Git integration — no secrets in GitHub)

Deployment deliberately does **not** run from GitHub Actions, so no
Cloudflare credentials are ever stored in the repository.
`.github/workflows/ci.yml` only *verifies* (typecheck, tests, build).
Cloudflare itself pulls the repo and deploys, via two Git connections you
create once in the Cloudflare dashboard (Cloudflare → GitHub OAuth):

1. **Worker (rooms + presign)** — Workers & Pages → the `eigakan-room`
   worker → Settings → Builds → connect this repo.
   - Root directory: `/` (repo root — the npm workspace lives there)
   - Build command: `npm install && npm run build:core`
   - Deploy command: `npx wrangler deploy --config worker/wrangler.toml`
2. **Web (Pages)** — Workers & Pages → Create → Pages → connect this repo.
   - Root directory: `/`
   - Build command: `npm install && npm run build`
   - Build output directory: `web/dist`
   - Environment variables: `PUBLIC_ROOM_API_URL` = the worker's URL
     (e.g. `https://eigakan-room.<your-subdomain>.workers.dev`),
     `PUBLIC_SITE_URL` = the Pages URL (e.g. `https://eigakan.pages.dev`)

After that, every push to `main` is built and deployed by Cloudflare;
the free `*.pages.dev` and `*.workers.dev` domains are enough — a custom
domain is optional polish, not a requirement.

### Path hosting on an existing domain (https://<domain>/eigakan)

Cloudflare binds custom domains to hostnames, not paths, so Eigakan can
live at `https://<your-domain>/eigakan` behind the path-proxy worker in
`proxy/` (decided 2026-10-21):

1. Deploy the room worker and the Pages site exactly as above.
2. Set the Pages build variables for the path instead:
   `PUBLIC_SITE_URL` = `https://<your-domain>` (bare origin),
   `PUBLIC_SITE_BASE` = `/eigakan`,
   `PUBLIC_ROOM_API_URL` = `https://<your-domain>/eigakan-api`
   — then redeploy Pages so the build picks them up.
3. Deploy the proxy as a third Git-connected worker
   (`proxy/wrangler.toml`; set `ROOM_ORIGIN` to the Step 1 worker URL
   first) and add two routes on your domain's zone:
   `<your-domain>/eigakan*` and `<your-domain>/eigakan-api*`.

The proxy strips the prefix and forwards to the Pages / worker origins
(WebSocket upgrades pass through), so visitors see one origin:
`/eigakan` for the site, `/eigakan-api` for the rooms. Routing logic is
covered by `npm run test:proxy` (10 checks).

## Private movie files via R2 (optional)

1. Keep the bucket **private** — never enable public access.
2. Create an R2 API token scoped to that single bucket (Object Read).
3. Set worker secrets: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (`wrangler secret put …`).
4. The worker route `GET /rooms/:code/files/:key/presign` then returns a
   signed URL valid for 4 hours.

The presign route is **gated by a room session** (since v0.3.0): when a
viewer joins a room, the Room object issues a random session token in its
`welcome` message, and the presign route requires it
(`X-Room-Session` header) — missing token → 401, wrong / other room's /
already-left viewer's token → 403. Knowing a room code and a file key
alone is no longer enough; the token dies when its viewer disconnects.

Security notes: presigned URLs are bearer links — anyone holding one can
use it until it expires, so keep expiries short and share them only inside
the room. Upload files with random object names, delete them after the
watch, and protect the Cloudflare account with 2FA/passkeys.

## Adaptive quality for R2 movies (HLS)

A single MP4 has one fixed bitrate — if a viewer's connection dips below
it, they stall (the room now pauses for both while they recover). For a
smoother ride, encode the movie once into an HLS ladder:

```bash
./scripts/encode-hls.sh movie.mp4          # → movie-hls/master.m3u8 + 720p/480p/360p
rclone copy ./movie-hls r2:<bucket>/movie-hls
```

Upload the whole folder to the **private** R2 bucket, then inside the
room enter the folder name (`movie-hls`) in the **R2 HLS folder** field.
Do *not* just presign and paste `master.m3u8`: a presigned URL signs
exactly one object, while HLS is a tree (master → rendition playlists →
segments) whose child requests would reach the private bucket unsigned
and fail. Instead the worker mints a signed playlist URL for room
members (HMAC bound to room + key + 4-hour expiry), serves the tiny
playlists itself with every child rewritten — rendition playlists as
signed worker URLs, segments as direct presigned R2 URLs — and each
player picks its own rendition based on live bandwidth, exactly like the
big platforms, minus their platform. Segments never transit the worker.

## Known MVP limits

- YouTube user-initiated seeks are detected via heartbeat drift, not an API
  event (the IFrame API does not emit one) — correction may take a few
  seconds for that specific gesture.
- Ads are not synchronized. Region/age-gated videos can still block a
  partner.
- Mobile browsers require a user tap before programmatic playback; the
  native player controls cover that path and state re-syncs on heartbeat.
