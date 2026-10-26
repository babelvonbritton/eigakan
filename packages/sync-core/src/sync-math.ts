import {
  DRIFT_RATE_THRESHOLD_SECONDS,
  DRIFT_SEEK_THRESHOLD_SECONDS,
  type Heartbeat,
  type PlaybackEvent,
} from './protocol';

/**
 * Where the sender's playhead will be when their event reaches us.
 *
 * The event carries the playhead position at send time; while the message is
 * in flight the sender keeps playing, so we project the position forward by
 * the one-way transit time. Without this, every remote play/pause lands late
 * by roughly the network latency and the two players never feel "in sync".
 */
export function projectEventPosition(event: PlaybackEvent, receivedAt: number): number {
  if (!event.playing) return event.videoTime;
  const transitSeconds = Math.max(0, receivedAt - event.sentAt) / 1000;
  return event.videoTime + transitSeconds * event.playbackRate;
}

/** Same projection for heartbeats: where the partner's playhead is *now*. */
export function projectHeartbeatPosition(heartbeat: Heartbeat, receivedAt: number): number {
  if (!heartbeat.playing) return heartbeat.videoTime;
  const transitSeconds = Math.max(0, receivedAt - heartbeat.sentAt) / 1000;
  return heartbeat.videoTime + transitSeconds * heartbeat.playbackRate;
}

/**
 * Project a playhead from the *server's* clock instead of the sender's.
 *
 * The sender's `sentAt` is stamped on the sender's wall clock, so comparing
 * it against the receiver's wall clock bakes any clock skew between the two
 * devices straight into the drift estimate — a steady half-second skew kept
 * the rate nudger firing every heartbeat, which used to ratchet the shared
 * base speed upward with nobody touching a control. The worker already
 * stamps every relayed message with `serverReceivedAt` (its own clock), so
 * both viewers can project from that one shared clock instead.
 *
 * `serverNowMs` is the receiver's estimate of the server clock "now" (see
 * ServerClock). The sender→server leg is deliberately not added: it is
 * unknown and small (tens of milliseconds, inside the rate deadband),
 * whereas the skew it replaces could be seconds.
 */
export function projectFromServerTime(
  videoTime: number,
  playbackRate: number,
  playing: boolean,
  serverReceivedAt: number,
  serverNowMs: number,
): number {
  if (!playing) return videoTime;
  const elapsedSeconds = Math.max(0, serverNowMs - serverReceivedAt) / 1000;
  return videoTime + elapsedSeconds * playbackRate;
}

/**
 * Estimates the room server's clock from the `serverReceivedAt` stamps on
 * relayed messages. For each message, `serverReceivedAt - receiptMs` equals
 * the negative one-way delay minus this device's offset from the server
 * clock, so the *maximum* sample over a recent window is the least-delayed
 * (most accurate) estimate of that offset. Samples older than a minute are
 * dropped so a mid-session clock adjustment cannot poison the estimate
 * forever.
 */
export class ServerClock {
  private samples: { at: number; sample: number }[] = [];

  observe(serverReceivedAt: number, receiptMs: number): void {
    this.samples.push({ at: receiptMs, sample: serverReceivedAt - receiptMs });
    const cutoff = receiptMs - 60_000;
    while (this.samples.length > 0 && this.samples[0].at < cutoff) this.samples.shift();
  }

  /** Estimated server time for a local receipt timestamp, or null before any sample. */
  nowEstimate(receiptMs: number): number | null {
    if (this.samples.length === 0) return null;
    let max = -Infinity;
    for (const s of this.samples) max = Math.max(max, s.sample);
    return receiptMs + max;
  }
}

export type DriftAction =
  | { action: 'none'; driftSeconds: number }
  | { action: 'rate'; driftSeconds: number; suggestedRate: number }
  | { action: 'seek'; driftSeconds: number; seekToSeconds: number };

/**
 * Decide how to correct the gap between our playhead and the partner's
 * projected playhead.
 *
 * - Under the rate threshold: ignore — chasing tiny drift causes visible stutter.
 * - Between thresholds: speed up / slow down slightly until we converge.
 * - Beyond the seek threshold: jump. Buffering stalls land here.
 *
 * Positive drift means the partner is AHEAD of us.
 */
export function decideDriftCorrection(
  localTimeSeconds: number,
  partnerProjectedTimeSeconds: number,
  localPlaybackRate = 1,
): DriftAction {
  const drift = partnerProjectedTimeSeconds - localTimeSeconds;
  const abs = Math.abs(drift);
  if (abs <= DRIFT_RATE_THRESHOLD_SECONDS) {
    return { action: 'none', driftSeconds: drift };
  }
  if (abs <= DRIFT_SEEK_THRESHOLD_SECONDS) {
    // Nudge by up to ~10% in the direction that closes the gap.
    const nudge = Math.min(0.1, abs / 10) * Math.sign(drift);
    return { action: 'rate', driftSeconds: drift, suggestedRate: localPlaybackRate + nudge };
  }
  return { action: 'seek', driftSeconds: drift, seekToSeconds: partnerProjectedTimeSeconds };
}
