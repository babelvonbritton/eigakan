import type { VideoSource } from '@eigakan/sync-core';

/** Actions a player can report about its *local* user / local state. */
export type LocalControlAction =
  | 'play'
  | 'pause'
  | 'seek'
  | 'rate'
  /** The local player stalled waiting for data. */
  | 'buffering-start'
  /** The local player recovered from a stall. */
  | 'buffering-end';

/**
 * The player adapter contract. The sync engine drives any source through this
 * interface, so YouTube, a remote MP4 and a local file behave identically.
 */
export interface PlayerAdapter {
  readonly kind: VideoSource['kind'];
  load(source: VideoSource): Promise<void>;
  play(): void;
  pause(): void;
  seekTo(seconds: number): void;
  setRate(rate: number): void;
  getTime(): number;
  getRate(): number;
  isPlaying(): boolean;
  isBuffering(): boolean;
  /** Subscribe to *local user* actions. Returns an unsubscribe function. */
  onLocalControl(handler: (action: LocalControlAction) => void): () => void;
  destroy(): void;
}

/**
 * A stall shorter than this is a blip (a quality switch, a hiccup), not a
 * real stall: reporting it would pause both viewers and then auto-resume
 * them for no reason. Only stalls that outlive the window count as buffering.
 */
const BUFFERING_DEBOUNCE_MS = 800;

/** HTML5 <video> adapter — serves both remote MP4 URLs and local files (blob URLs). */
export class Html5PlayerAdapter implements PlayerAdapter {
  readonly kind: VideoSource['kind'];
  private readonly video: HTMLVideoElement;
  private objectUrl: string | null = null;
  private hls: { destroy(): void } | null = null;

  constructor(video: HTMLVideoElement, kind: VideoSource['kind'] = 'mp4') {
    this.video = video;
    this.kind = kind;
  }

  async load(source: VideoSource): Promise<void> {
    if (source.kind === 'local-file') {
      throw new Error('Use loadLocalFile() for local files');
    }
    this.detachHls();
    if (source.kind === 'hls') {
      await this.loadHls(source.ref);
      return;
    }
    this.video.src = source.ref;
    this.video.load();
  }

  /**
   * HLS with adaptive bitrate: hls.js (MSE) where supported, native HLS in
   * Safari. The ABR ladder itself lives in the .m3u8 rendition set — see
   * scripts/encode-hls.sh for producing one from a movie file.
   */
  private async loadHls(url: string): Promise<void> {
    if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.video.src = url;
      this.video.load();
      return;
    }
    const { default: Hls } = await import('hls.js');
    if (Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 30 });
      hls.loadSource(url);
      hls.attachMedia(this.video);
      this.hls = hls;
      return;
    }
    // Last resort: some browsers will still try the URL directly.
    this.video.src = url;
    this.video.load();
  }

  private detachHls(): void {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
  }

  /** Load a file the user picked on *this* device. The file never leaves the device. */
  loadLocalFile(file: File): void {
    this.detachHls();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    this.video.src = this.objectUrl;
    this.video.load();
  }

  play(): void {
    void this.video.play().catch(() => {
      // Autoplay policies: the join tap usually satisfies them; if not, the
      // user can press the native play control — state re-syncs on heartbeat.
    });
  }
  pause(): void {
    this.video.pause();
  }
  seekTo(seconds: number): void {
    if (Number.isFinite(seconds)) this.video.currentTime = Math.max(0, seconds);
  }
  setRate(rate: number): void {
    this.video.playbackRate = rate;
  }
  getTime(): number {
    return this.video.currentTime || 0;
  }
  getRate(): number {
    return this.video.playbackRate || 1;
  }
  isPlaying(): boolean {
    return !this.video.paused && !this.video.ended;
  }
  isBuffering(): boolean {
    return this.video.readyState < 3 && !this.video.paused;
  }
  onLocalControl(handler: (action: LocalControlAction) => void): () => void {
    let buffering = false;
    let waiting = false;
    let waitingTimer: ReturnType<typeof setTimeout> | null = null;
    const clearWaitingTimer = () => {
      if (waitingTimer !== null) {
        clearTimeout(waitingTimer);
        waitingTimer = null;
      }
    };
    const onPlay = () => handler('play');
    const onPause = () => handler('pause');
    const onSeeked = () => handler('seek');
    const onRate = () => handler('rate');
    const onWaiting = () => {
      waiting = true;
      if (buffering || waitingTimer !== null) return;
      // Debounced: only a stall that outlives the window reports buffering.
      waitingTimer = setTimeout(() => {
        waitingTimer = null;
        if (waiting && !buffering) {
          buffering = true;
          handler('buffering-start');
        }
      }, BUFFERING_DEBOUNCE_MS);
    };
    const onPlaying = () => {
      clearWaitingTimer();
      waiting = false;
      if (buffering) {
        buffering = false;
        handler('buffering-end');
      }
    };
    this.video.addEventListener('play', onPlay);
    this.video.addEventListener('pause', onPause);
    this.video.addEventListener('seeked', onSeeked);
    this.video.addEventListener('ratechange', onRate);
    this.video.addEventListener('waiting', onWaiting);
    this.video.addEventListener('stalled', onWaiting);
    this.video.addEventListener('playing', onPlaying);
    this.video.addEventListener('canplay', onPlaying);
    return () => {
      clearWaitingTimer();
      this.video.removeEventListener('play', onPlay);
      this.video.removeEventListener('pause', onPause);
      this.video.removeEventListener('seeked', onSeeked);
      this.video.removeEventListener('ratechange', onRate);
      this.video.removeEventListener('waiting', onWaiting);
      this.video.removeEventListener('stalled', onWaiting);
      this.video.removeEventListener('playing', onPlaying);
      this.video.removeEventListener('canplay', onPlaying);
    };
  }
  destroy(): void {
    this.detachHls();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }
}

interface YTPlayer {
  loadVideoById(videoId: string): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setPlaybackRate(rate: number): void;
  getCurrentTime(): number;
  getPlaybackRate(): number;
  getPlayerState(): number;
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    elementId: string,
    options: {
      videoId?: string;
      width?: string | number;
      height?: string | number;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (event: { data: number }) => void;
        onPlaybackRateChange?: () => void;
      };
    },
  ) => YTPlayer;
  PlayerState: { PLAYING: number; PAUSED: number; BUFFERING: number };
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytApiPromise: Promise<YTNamespace> | null = null;

function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT) resolve(window.YT);
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
  return ytApiPromise;
}

/** YouTube IFrame API adapter. */
export class YouTubePlayerAdapter implements PlayerAdapter {
  readonly kind = 'youtube' as const;
  private player: YTPlayer | null = null;
  private readonly ready: Promise<void>;
  private lastState = -1;
  private bufferingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly elementId: string) {
    this.ready = (async () => {
      const YT = await loadYouTubeApi();
      this.player = new YT.Player(this.elementId, {
        // Without explicit dimensions the API builds a fixed 640x360 iframe
        // that bursts out of the stage on phones; 100% defers to the stage
        // (and the .stage iframe CSS rule is the backstop).
        width: '100%',
        height: '100%',
        playerVars: { rel: 0, playsinline: 1 },
        events: {
          onStateChange: (event) => {
            this.lastState = event.data;
            const handler = this.stateHandler;
            if (!handler) return;
            if (event.data === YT.PlayerState.PLAYING) {
              if (this.bufferingTimer !== null) {
                clearTimeout(this.bufferingTimer);
                this.bufferingTimer = null;
              }
              handler('buffering-end');
              handler('play');
            } else if (event.data === YT.PlayerState.PAUSED) {
              if (this.bufferingTimer !== null) {
                clearTimeout(this.bufferingTimer);
                this.bufferingTimer = null;
              }
              handler('pause');
            } else if (event.data === YT.PlayerState.BUFFERING) {
              // Debounced: YouTube fires BUFFERING on quality switches and
              // brief dips too. Only a stall that outlives the window
              // pauses both viewers (see BUFFERING_DEBOUNCE_MS).
              if (this.bufferingTimer === null) {
                this.bufferingTimer = setTimeout(() => {
                  this.bufferingTimer = null;
                  if (this.lastState === YT.PlayerState.BUFFERING) handler('buffering-start');
                }, BUFFERING_DEBOUNCE_MS);
              }
            } else if (this.bufferingTimer !== null) {
              // Any other state (ended, cued, unstarted) cancels a pending blip.
              clearTimeout(this.bufferingTimer);
              this.bufferingTimer = null;
            }
          },
          onPlaybackRateChange: () => this.stateHandler?.('rate'),
        },
      });
    })();
  }

  private stateHandler: ((action: LocalControlAction) => void) | null = null;

  async load(source: VideoSource): Promise<void> {
    await this.ready;
    this.player?.loadVideoById(source.ref);
  }
  play(): void {
    this.player?.playVideo();
  }
  pause(): void {
    this.player?.pauseVideo();
  }
  seekTo(seconds: number): void {
    // The IFrame API has no seek *event* for remote seeks; local user seeks
    // are detected by the heartbeat drift check instead.
    this.player?.seekTo(Math.max(0, seconds), true);
  }
  setRate(rate: number): void {
    this.player?.setPlaybackRate(rate);
  }
  getTime(): number {
    return this.player?.getCurrentTime() ?? 0;
  }
  getRate(): number {
    return this.player?.getPlaybackRate() ?? 1;
  }
  isPlaying(): boolean {
    return this.lastState === 1; // YT.PlayerState.PLAYING
  }
  isBuffering(): boolean {
    return this.lastState === 3; // YT.PlayerState.BUFFERING
  }
  onLocalControl(handler: (action: LocalControlAction) => void): () => void {
    this.stateHandler = handler;
    return () => {
      if (this.stateHandler === handler) this.stateHandler = null;
    };
  }
  destroy(): void {
    if (this.bufferingTimer !== null) {
      clearTimeout(this.bufferingTimer);
      this.bufferingTimer = null;
    }
    this.player?.destroy();
    this.player = null;
  }
}
