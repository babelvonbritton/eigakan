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
