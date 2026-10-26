import {
  decideDriftCorrection,
  projectEventPosition,
  projectFromServerTime,
  projectHeartbeatPosition,
  ServerClock,
  type ClientMessage,
  type Heartbeat,
  type PlaybackEvent,
  type PresencePerson,
  type ServerMessage,
  type VideoSource,
} from '@eigakan/sync-core';
import type { LocalControlAction, PlayerAdapter } from './players';

export type RoomStatus =
  | 'connecting'
  | 'waiting' // alone in the room
  | 'paired' // partner present
  | 'full' // rejected: room already has two viewers
  | 'ended' // the host terminated the room for everyone
  | 'reconnecting' // socket lost, retrying with backoff
  | 'closed';

export interface RoomClientCallbacks {
  onStatus(status: RoomStatus, peers: number): void;
  onError(message: string): void;
  /** The welcome message has supplied the room-session token; gated R2 calls may start. */
  onSessionReady?: () => void;
  /** Everyone currently in the room, in join order, with host/you flags. */
  onPresence(people: PresencePerson[]): void;
  /** `name` is the sender's display name (own name for own messages). */
  onChat(text: string, mine: boolean, name: string): void;
  /** A chat the user tried to send while offline — shown, never silently dropped. */
  onChatUndelivered?: (text: string) => void;
  onPartnerBuffering(buffering: boolean): void;
  onSourceLoaded(source: VideoSource): void;
}

/** One completed in-site upload, reusable from later rooms until R2 lifecycle expiry or manual deletion. */
export interface UploadedMovie {
  key: string;
  title: string;
  size: number;
  uploadedAt: string;
  sourceRoom: string;
}

export interface RoomClientOptions {
  /** Display name shown to the partner (a label, not an account). */
  displayName: string;
  /** True for the room's creator — enables endRoom(). */
  isHost: boolean;
}

const HEARTBEAT_INTERVAL_MS = 4_000;
/** Silence longer than this from a present partner means the socket is dead even if it looks open. */
const PEER_TIMEOUT_MS = 12_000;
/** Reconnect backoff: 1s, 2s, 4s, then 8s; give up after this many attempts. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 8_000;
const RECONNECT_MAX_ATTEMPTS = 10;

/**
 * The sync engine. Owns the WebSocket to the room's Durable Object and keeps
 * the local player aligned with the partner's:
 *
 * - local user actions are broadcast immediately as PlaybackEvents;
 * - incoming events are applied with latency compensation (the sender kept
 *   playing while the message travelled);
 * - heartbeats every few seconds feed the drift corrector (rate nudge for
 *   small gaps, seek for stalls).
 *
 * An "echo guard" (`applyingRemoteUntil`) prevents actions we apply *for* the
 * partner from being re-broadcast as if the local user did them.
 */
export class RoomClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: number | null = null;
  private applyingRemoteUntil = 0;
  /**
   * Until this time, 'rate' reports from the player are the sync engine's
   * own doing (a heartbeat nudge or a remote rate event), not the user.
   * Without this guard, an engine nudge was mistaken for a user speed
   * change: it rewrote baseRate and was broadcast, so every heartbeat
   * nudged from an ever-higher base and the speed visibly ran away.
   */
  private engineRateUntil = 0;
  private baseRate = 1;
  /** Shared server-clock estimate, fed by the serverReceivedAt stamps on relayed messages. */
  private serverClock = new ServerClock();
  /** Last time any message from the partner arrived; 0 until the first one. */
  private lastPeerActivityAt = 0;
  private seenPeerActivity = false;
  private peerCount = 0;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private userClosed = false;
  private controlSubscribed = false;
  private currentSource: VideoSource | null = null;
  /** Room-session token from `welcome`; gates the R2 presign route. Dies with the socket. */
  private sessionToken: string | null = null;
  private connectionErrorReported = false;
  private terminalStatusReceived = false;
  /** This viewer stalled and asked the room to wait (pause-both rule). */
  private localBufferingHold = false;
  /** The partner stalled; we paused for them and resume on their buffer-resume. */
  private partnerBufferingHold = false;

  constructor(
    private readonly apiBase: string,
    private readonly roomCode: string,
    private readonly player: PlayerAdapter,
    private readonly callbacks: RoomClientCallbacks,
    private readonly options: RoomClientOptions = { displayName: 'Guest', isHost: false },
  ) {}

  connect(): void {
    this.userClosed = false;
    this.reconnectAttempts = 0;
    // Subscribe exactly once: reconnects re-open the socket, they must
    // never re-subscribe, or every local action would broadcast twice.
    if (!this.controlSubscribed) {
      this.controlSubscribed = true;
      this.player.onLocalControl((action) => this.handleLocalControl(action));
    }
    this.connectSocket();
    this.startHeartbeat();
  }

  /** Open (or re-open) the room socket. Reconnect-safe: no player subscriptions here. */
  private connectSocket(): void {
    if (this.userClosed || this.terminalStatusReceived) return;
    const wsBase = this.apiBase.replace(/^http/, 'ws');
    const query = new URLSearchParams({ name: this.options.displayName });
    if (this.options.isHost) query.set('host', '1');
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${wsBase}/rooms/${this.roomCode}/ws?${query.toString()}`);
    } catch {
      this.connectionErrorReported = true;
      this.callbacks.onError('Could not connect to the room server. Check the room server URL and try again.');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      // A fresh socket resets the backoff, and announcing our state right
      // away lets the partner's drift logic realign us without waiting
      // for the next heartbeat tick.
      this.reconnectAttempts = 0;
      this.sendHeartbeat();
    });

    ws.addEventListener('message', (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handleServerMessage(message);
    });

    ws.addEventListener('error', () => {
      this.connectionErrorReported = true;
      this.callbacks.onError('Could not connect to the room server. Check your connection and room server URL.');
    });

    ws.addEventListener('close', () => {
      // A superseded socket (already replaced by a newer connectSocket)
      // must not drive reconnects.
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopHeartbeat();
      this.sessionToken = null;
      if (this.userClosed || this.terminalStatusReceived) return;
      this.scheduleReconnect();
    });
  }

  /** Retry a lost socket with backoff; after repeated failures, stop and let the user rejoin manually. */
  private scheduleReconnect(): void {
    if (this.userClosed || this.terminalStatusReceived || this.reconnectTimer !== null) return;
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.callbacks.onStatus('closed', 0);
      return;
    }
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    this.callbacks.onStatus('reconnecting', 0);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.userClosed || this.terminalStatusReceived) return;
      this.connectionErrorReported = false;
      this.connectSocket();
      this.startHeartbeat();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      this.sendHeartbeat();
      this.checkPeerTimeout();
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** A socket that looks open but hasn't relayed a partner message in a while is half-dead. */
  private checkPeerTimeout(): void {
    if (!this.seenPeerActivity || this.peerCount < 2) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastPeerActivityAt <= PEER_TIMEOUT_MS) return;
    this.ws.close(); // the close handler drives the reconnect
  }

  /** Ask the room to load a source for both viewers. */
  loadSource(source: VideoSource): void {
    this.currentSource = source;
    this.sendEvent({
      kind: 'load',
      source,
      videoTime: 0,
      sentAt: Date.now(),
      playbackRate: 1,
      playing: false,
    });
    void (async () => {
      const resolved = await this.resolveForPlayer(source);
      if (resolved) await this.player.load(resolved);
    })();
    this.callbacks.onSourceLoaded(source);
  }

  /**
   * An r2-file source carries only the object key; each viewer turns it
   * into their own presigned URL (their own room-session token), so no
   * signed URL — a bearer credential — is ever relayed through the room.
   * Every other kind passes through unchanged.
   */
  private async resolveForPlayer(source: VideoSource): Promise<VideoSource | null> {
    if (source.kind !== 'r2-file') return source;
    try {
      const url = await this.fetchPresignedUrl(source.ref);
      return { kind: 'mp4', ref: url, title: source.title };
    } catch (error) {
      this.callbacks.onError(
        `Could not get a viewing link for "${source.title ?? 'the uploaded movie'}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /** Local files: the *file* stays on this device; only the load event (name only) is shared. */
  loadLocalFile(file: File, html5: { loadLocalFile(file: File): void }): void {
    const source: VideoSource = { kind: 'local-file', ref: file.name };
    this.currentSource = source;
    this.sendEvent({
      kind: 'load',
      source,
      videoTime: 0,
      sentAt: Date.now(),
      playbackRate: 1,
      playing: false,
    });
    html5.loadLocalFile(file);
    this.callbacks.onSourceLoaded(source);
  }

  /**
   * Ask the worker for a short-lived R2 URL for `key` in this room.
   * The room-session token proves this browser is a joined viewer; the
   * worker refuses (401/403) anyone who only knows the room code.
   */
  async fetchPresignedUrl(key: string): Promise<string> {
    if (!this.sessionToken) throw new Error('Not joined to the room yet — no session token.');
    const res = await fetch(
      `${this.apiBase}/rooms/${this.roomCode}/files/${encodeURIComponent(key)}/presign`,
      { headers: { 'X-Room-Session': this.sessionToken } },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Presign failed (${res.status})`);
    }
    const body = (await res.json()) as { url: string };
    return body.url;
  }

  /**
   * List completed in-site uploads across all previous rooms. The current
   * room session only proves this viewer belongs inside Eigakan now; the
   * library itself is deliberately reusable until a movie expires from R2
   * or is deleted from this list.
   */
  async listUploadedMovies(): Promise<UploadedMovie[]> {
    if (!this.sessionToken) throw new Error('Not joined to the room yet — no session token.');
    const res = await fetch(`${this.apiBase}/rooms/${this.roomCode}/library`, {
      headers: { 'X-Room-Session': this.sessionToken },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Could not load the uploads library (${res.status})`);
    }
    const body = (await res.json()) as { movies?: UploadedMovie[] };
    return Array.isArray(body.movies) ? body.movies : [];
  }

  /** Permanently remove one uploaded movie from R2 and therefore from every room's library. */
  async deleteUploadedMovie(key: string): Promise<void> {
    if (!this.sessionToken) throw new Error('Not joined to the room yet — no session token.');
    const res = await fetch(`${this.apiBase}/rooms/${this.roomCode}/library/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Room-Session': this.sessionToken },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Could not delete that movie (${res.status})`);
    }
  }

  /**
   * Ask the worker to mint a signed HLS viewing URL for an R2 prefix
   * (e.g. "movie-hls" for the ladder uploaded by scripts/encode-hls.sh).
   * The returned URL points at the worker itself: it serves rewritten
   * playlists whose segments are presigned R2 URLs, so the private
   * bucket works with HLS's tree of files — a single presigned
   * master.m3u8 link cannot. Load the result as an `hls` source.
   */
  async fetchHlsUrl(prefix: string): Promise<string> {
    if (!this.sessionToken) throw new Error('Not joined to the room yet — no session token.');
    const clean = prefix.trim().replace(/^\/+|\/+$/g, '');
    if (!clean) throw new Error('Enter the R2 folder (prefix) of the HLS ladder, e.g. movie-hls.');
    const encoded = clean.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(`${this.apiBase}/rooms/${this.roomCode}/hls/${encoded}/mint`, {
      headers: { 'X-Room-Session': this.sessionToken },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `HLS mint failed (${res.status})`);
    }
    const body = (await res.json()) as { url: string };
    return body.url;
  }

  private async uploadCall<T>(path: string, payload: Record<string, unknown>): Promise<T> {
    if (!this.sessionToken) throw new Error('Not joined to the room yet — no session token.');
    const res = await fetch(`${this.apiBase}/rooms/${this.roomCode}/uploads/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Room-Session': this.sessionToken },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Upload request failed (${res.status})`);
    }
    return (await res.json()) as T;
  }

  /**
   * Upload a movie file straight from this browser to the private R2
   * bucket (the bytes never pass through the worker): the worker brokers
   * an S3 multipart session, this method PUTs 32 MiB parts to presigned
   * URLs (3 in parallel, each retried), then completes the upload.
   * Resolves with the object key; load it for both with loadSource({
   * kind: 'r2-file', ref: key }).
   */
  async uploadMovie(
    file: File,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
  ): Promise<string> {
    const PART_SIZE = 32 * 1024 * 1024;
    const CONCURRENCY = 3;
    const { key, uploadId } = await this.uploadCall<{ key: string; uploadId: string }>('create', {
      filename: file.name,
      size: file.size,
    });
    try {
      const partCount = Math.max(1, Math.ceil(file.size / PART_SIZE));
      const etags: { partNumber: number; etag: string }[] = [];
      let nextPart = 1;
      let doneBytes = 0;
      const runWorker = async (): Promise<void> => {
        while (nextPart <= partCount) {
          if (signal.aborted) throw new DOMException('Upload cancelled.', 'AbortError');
          const partNumber = nextPart++;
          const blob = file.slice((partNumber - 1) * PART_SIZE, Math.min(file.size, partNumber * PART_SIZE));
          const etag = await this.uploadPartWithRetry(key, uploadId, partNumber, blob, signal);
          etags.push({ partNumber, etag });
          doneBytes += blob.size;
          onProgress(doneBytes / file.size);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, partCount) }, runWorker));
      if (signal.aborted) throw new DOMException('Upload cancelled.', 'AbortError');
      await this.uploadCall('complete', { key, uploadId, parts: etags });
      return key;
    } catch (error) {
      // Best effort: an abandoned multipart session would otherwise keep
      // its uploaded parts in the bucket until a lifecycle rule sweeps.
      await this.uploadCall('abort', { key, uploadId }).catch(() => undefined);
      throw error;
    }
  }

  private async uploadPartWithRetry(
    key: string,
    uploadId: string,
    partNumber: number,
    blob: Blob,
    signal: AbortSignal,
  ): Promise<string> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { url } = await this.uploadCall<{ url: string }>('sign-part', { key, uploadId, partNumber });
        const res = await fetch(url, { method: 'PUT', body: blob, signal });
        if (!res.ok) throw new Error(`Part ${partNumber} was refused (${res.status}).`);
        const etag = res.headers.get('ETag');
        if (!etag) {
          throw new Error('R2 did not expose an ETag for the uploaded part — the bucket CORS policy must list ETag in ExposeHeaders (see the Step 4 setup).');
        }
        return etag;
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Part ${partNumber} failed to upload.`);
  }

  sendChat(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // Never fake delivery: the sender must see that this one didn't go out.
      this.callbacks.onChatUndelivered?.(trimmed);
      return;
    }
    this.send({ type: 'chat', text: trimmed, sentAt: Date.now() });
    this.callbacks.onChat(trimmed, true, this.options.displayName);
  }

  /**
   * Host only: terminate the room for BOTH viewers. The server notifies the
   * partner (room-ended) and closes every socket, which also kills every
   * room-session token — the code and any shared links stop working.
   */
  endRoom(): void {
    this.send({ type: 'end-room' });
  }

  close(): void {
    this.userClosed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }

  // ——— internals ———

  private handleServerMessage(message: ServerMessage): void {
    if (
      (message.type === 'peer-event' || message.type === 'peer-heartbeat' || message.type === 'peer-chat') &&
      typeof message.serverReceivedAt === 'number'
    ) {
      // Every relayed message carries the server's clock: feed the shared
      // clock estimate and prove the partner (and the socket) is alive.
      this.serverClock.observe(message.serverReceivedAt, Date.now());
      this.lastPeerActivityAt = Date.now();
      this.seenPeerActivity = true;
    }
    switch (message.type) {
      case 'welcome':
        this.sessionToken = message.sessionToken;
        this.callbacks.onSessionReady?.();
      // fallthrough — welcome also carries the peer count
      case 'presence': {
        const peers = message.peers;
        this.peerCount = peers;
        if (message.type === 'presence') {
          // Fallback covers a not-yet-redeployed worker that sends names only.
          const people = message.people
            ?? message.names.map((name) => ({ name, isHost: false, isYou: false }));
          this.callbacks.onPresence(people);
        }
        if (peers >= 2) this.callbacks.onStatus('paired', peers);
        else this.callbacks.onStatus('waiting', peers);
        break;
      }
      case 'room-ended':
        this.terminalStatusReceived = true;
        this.stopHeartbeat();
        this.sessionToken = null;
        this.callbacks.onStatus('ended', 0);
        break;
      case 'room-full':
        this.terminalStatusReceived = true;
        this.callbacks.onStatus('full', 2);
        break;
      case 'error':
        this.terminalStatusReceived = true;
        this.callbacks.onError(message.message);
        break;
      case 'peer-event':
        void this.applyRemoteEvent(message.event);
        break;
      case 'peer-heartbeat':
        this.applyRemoteHeartbeat(message.heartbeat, message.serverReceivedAt);
        break;
      case 'peer-chat':
        this.callbacks.onChat(message.text, false, message.name);
        break;
      case 'error':
        break;
    }
  }

  private async applyRemoteEvent(event: PlaybackEvent): Promise<void> {
    this.applyingRemoteUntil = Date.now() + 750;
    this.engineRateUntil = Date.now() + 750;
    if (event.kind === 'load' && event.source) {
      this.currentSource = event.source;
      if (event.source.kind !== 'local-file') {
        const resolved = await this.resolveForPlayer(event.source);
        if (resolved) await this.player.load(resolved);
      }
      this.callbacks.onSourceLoaded(event.source);
      return;
    }
    const target = projectEventPosition(event, Date.now());
    switch (event.kind) {
      case 'buffer-pause':
        // Pause-both rule: wait with the partner instead of drifting away.
        this.partnerBufferingHold = true;
        this.callbacks.onPartnerBuffering(true);
        this.player.seekTo(event.videoTime);
        this.player.pause();
        break;
      case 'buffer-resume':
        this.partnerBufferingHold = false;
        this.callbacks.onPartnerBuffering(false);
        this.player.seekTo(target);
        if (event.playing) this.player.play();
        break;
      case 'play':
        this.player.seekTo(target);
        this.player.setRate(event.playbackRate);
        this.player.play();
        break;
      case 'pause':
        this.player.seekTo(event.videoTime);
        this.player.pause();
        break;
      case 'seek':
        this.player.seekTo(target);
        if (event.playing) this.player.play();
        else this.player.pause();
        break;
      case 'rate':
        this.baseRate = event.playbackRate;
        this.player.setRate(event.playbackRate);
        break;
    }
  }

  private applyRemoteHeartbeat(heartbeat: Heartbeat, serverReceivedAt?: number): void {
    this.callbacks.onPartnerBuffering(heartbeat.buffering || this.partnerBufferingHold);
    if (!this.currentSource) return;
    // Only correct against a playing partner; if both are paused there is
    // nothing to drift away from.
    if (!heartbeat.playing && !this.player.isPlaying()) return;
    const now = Date.now();
    // Prefer the shared server clock: projecting from the sender's wall
    // clock bakes inter-device clock skew into the drift estimate.
    const serverNow = this.serverClock.nowEstimate(now);
    const partnerNow =
      serverNow !== null && typeof serverReceivedAt === 'number'
        ? projectFromServerTime(
            heartbeat.videoTime,
            heartbeat.playbackRate,
            heartbeat.playing,
            serverReceivedAt,
            serverNow,
          )
        : projectHeartbeatPosition(heartbeat, now);
    const decision = decideDriftCorrection(this.player.getTime(), partnerNow, this.baseRate);
    if (decision.action === 'seek') {
      this.applyingRemoteUntil = Date.now() + 750;
      this.player.seekTo(decision.seekToSeconds);
    } else if (decision.action === 'rate') {
      // Engine nudge, not a user choice: mark it so the player's rate
      // report is not mistaken for one (see handleLocalControl).
      this.engineRateUntil = Date.now() + 750;
      this.player.setRate(decision.suggestedRate);
    } else {
      // Back in tolerance: restore the agreed base rate if we were nudging.
      if (Math.abs(this.player.getRate() - this.baseRate) > 0.001 && this.player.isPlaying()) {
        this.engineRateUntil = Date.now() + 750;
        this.player.setRate(this.baseRate);
      }
    }
  }

  private handleLocalControl(action: LocalControlAction): void {
    if (Date.now() < this.applyingRemoteUntil) return; // echo guard

    if (action === 'buffering-start') {
      // Pause-both rule: only hold the room if we were actually playing.
      if (!this.localBufferingHold && (this.player.isPlaying() || this.player.isBuffering())) {
        this.localBufferingHold = true;
        this.sendEvent({
          kind: 'buffer-pause',
          videoTime: this.player.getTime(),
          sentAt: Date.now(),
          playbackRate: this.player.getRate(),
          playing: false,
        });
      }
      return;
    }
    if (action === 'buffering-end') {
      if (this.localBufferingHold) {
        this.localBufferingHold = false;
        this.sendEvent({
          kind: 'buffer-resume',
          videoTime: this.player.getTime(),
          sentAt: Date.now(),
          playbackRate: this.player.getRate(),
          playing: true,
        });
      }
      return;
    }

    if (action === 'rate') {
      // A rate report caused by the engine's own nudge (or by a remote
      // rate event) must not rewrite the user's base speed or be
      // re-broadcast — that feedback loop used to walk the speed away
      // on its own, with nobody touching a control.
      if (Date.now() < this.engineRateUntil) return;
      this.baseRate = this.player.getRate();
    }
    this.sendEvent({
      kind: action,
      videoTime: this.player.getTime(),
      sentAt: Date.now(),
      playbackRate: this.player.getRate(),
      playing: this.player.isPlaying(),
    });
  }

  private sendHeartbeat(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const heartbeat: Heartbeat = {
      videoTime: this.player.getTime(),
      sentAt: Date.now(),
      playing: this.player.isPlaying(),
      playbackRate: this.player.getRate(),
      buffering: this.player.isBuffering(),
    };
    this.send({ type: 'heartbeat', heartbeat });
  }

  private sendEvent(event: PlaybackEvent): void {
    this.send({ type: 'event', event });
  }

  private send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
