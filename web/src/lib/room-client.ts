import {
  decideDriftCorrection,
  projectEventPosition,
  projectHeartbeatPosition,
  type ClientMessage,
  type Heartbeat,
  type PlaybackEvent,
  type ServerMessage,
  type VideoSource,
} from '@eigakan/sync-core';
import type { LocalControlAction, PlayerAdapter } from './players';

export type RoomStatus =
  | 'connecting'
  | 'waiting' // alone in the room
  | 'paired' // partner present
  | 'full' // rejected: room already has two viewers
  | 'closed';

export interface RoomClientCallbacks {
  onStatus(status: RoomStatus, peers: number): void;
  onChat(text: string, mine: boolean): void;
  onPartnerBuffering(buffering: boolean): void;
  onSourceLoaded(source: VideoSource): void;
}

const HEARTBEAT_INTERVAL_MS = 4_000;

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
  private baseRate = 1;
  private currentSource: VideoSource | null = null;
  /** Room-session token from `welcome`; gates the R2 presign route. Dies with the socket. */
  private sessionToken: string | null = null;
  /** This viewer stalled and asked the room to wait (pause-both rule). */
  private localBufferingHold = false;
  /** The partner stalled; we paused for them and resume on their buffer-resume. */
  private partnerBufferingHold = false;

  constructor(
    private readonly apiBase: string,
    private readonly roomCode: string,
    private readonly player: PlayerAdapter,
    private readonly callbacks: RoomClientCallbacks,
  ) {}

  connect(): void {
    const wsBase = this.apiBase.replace(/^http/, 'ws');
    this.ws = new WebSocket(`${wsBase}/rooms/${this.roomCode}/ws`);

    this.ws.addEventListener('message', (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handleServerMessage(message);
    });

    this.ws.addEventListener('close', () => {
      this.stopHeartbeat();
      this.sessionToken = null;
      this.callbacks.onStatus('closed', 0);
    });

    this.player.onLocalControl((action) => this.handleLocalControl(action));

    this.heartbeatTimer = window.setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
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
    void this.player.load(source);
    this.callbacks.onSourceLoaded(source);
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

  sendChat(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.send({ type: 'chat', text: trimmed, sentAt: Date.now() });
    this.callbacks.onChat(trimmed, true);
  }

  close(): void {
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }

  // ——— internals ———

  private handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome':
        this.sessionToken = message.sessionToken;
      // fallthrough — welcome also carries the peer count
      case 'presence': {
        const peers = message.peers;
        if (peers >= 2) this.callbacks.onStatus('paired', peers);
        else this.callbacks.onStatus('waiting', peers);
        break;
      }
      case 'room-full':
        this.callbacks.onStatus('full', 2);
        break;
      case 'peer-event':
        void this.applyRemoteEvent(message.event);
        break;
      case 'peer-heartbeat':
        this.applyRemoteHeartbeat(message.heartbeat);
        break;
      case 'peer-chat':
        this.callbacks.onChat(message.text, false);
        break;
      case 'error':
        break;
    }
  }

  private async applyRemoteEvent(event: PlaybackEvent): Promise<void> {
    this.applyingRemoteUntil = Date.now() + 750;
    if (event.kind === 'load' && event.source) {
      this.currentSource = event.source;
      if (event.source.kind !== 'local-file') {
        await this.player.load(event.source);
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

  private applyRemoteHeartbeat(heartbeat: Heartbeat): void {
    this.callbacks.onPartnerBuffering(heartbeat.buffering || this.partnerBufferingHold);
    if (!this.currentSource) return;
    // Only correct against a playing partner; if both are paused there is
    // nothing to drift away from.
    if (!heartbeat.playing && !this.player.isPlaying()) return;
    const partnerNow = projectHeartbeatPosition(heartbeat, Date.now());
    const decision = decideDriftCorrection(this.player.getTime(), partnerNow, this.baseRate);
    if (decision.action === 'seek') {
      this.applyingRemoteUntil = Date.now() + 750;
      this.player.seekTo(decision.seekToSeconds);
    } else if (decision.action === 'rate') {
      this.player.setRate(decision.suggestedRate);
    } else {
      // Back in tolerance: restore the agreed base rate if we were nudging.
      if (Math.abs(this.player.getRate() - this.baseRate) > 0.001 && this.player.isPlaying()) {
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

    if (action === 'rate') this.baseRate = this.player.getRate();
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
