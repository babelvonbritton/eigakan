/**
 * Wire protocol for Eigakan rooms.
 *
 * Every message is a small JSON object. Media never passes through the room:
 * the messages only describe *what each player should do*, so YouTube, a
 * remote MP4, and a local file all share this exact protocol.
 */

export type SourceKind = 'youtube' | 'mp4' | 'hls' | 'local-file' | 'r2-file';

export interface VideoSource {
  kind: SourceKind;
  /**
   * YouTube video id (kind=youtube), an https URL (kind=mp4/hls), or an R2
   * object key (kind=r2-file — each viewer resolves their own presigned URL
   * for it, so no credential ever travels in the load event). Local files
   * never leave the device, so they carry no URL.
   */
  ref: string;
  title?: string;
}

export type PlaybackEventKind =
  | 'load'
  | 'play'
  | 'pause'
  | 'seek'
  | 'rate'
  /** Sender stalled: partner should pause too, so the room waits together. */
  | 'buffer-pause'
  /** Sender recovered: partner resumes from the sender's projected position. */
  | 'buffer-resume';

export interface PlaybackEvent {
  kind: PlaybackEventKind;
  /** Present on 'load'. */
  source?: VideoSource;
  /** Playhead position in seconds on the sender's player when the event was created. */
  videoTime: number;
  /** Wall-clock send time (ms since epoch) on the sender. Used for latency compensation. */
  sentAt: number;
  /** Playback rate after the event (1 = normal). */
  playbackRate: number;
  /** True when the sender is playing after this event, false when paused. */
  playing: boolean;
}

export interface Heartbeat {
  videoTime: number;
  sentAt: number;
  playing: boolean;
  playbackRate: number;
  /** Sender is stalled waiting for data. The partner UI can show "partner is buffering". */
  buffering: boolean;
}

export type ClientMessage =
  | { type: 'event'; event: PlaybackEvent }
  | { type: 'heartbeat'; heartbeat: Heartbeat }
  | { type: 'chat'; text: string; sentAt: number }
  /** Host only: terminate the room for everyone. The code stops working. */
  | { type: 'end-room' };

/** One person in a room, as carried by presence updates. */
export interface PresencePerson {
  name: string;
  /** This person created the room (they hold the End room power). */
  isHost: boolean;
  /** True for the entry that is the receiving viewer themself — the server
   * personalizes each presence payload per recipient socket. */
  isYou: boolean;
}

export type ServerMessage =
  | { type: 'welcome'; peerId: string; peers: number; sessionToken: string }
  | { type: 'presence'; peers: number; names: string[]; people: PresencePerson[] }
  | { type: 'peer-event'; event: PlaybackEvent; serverReceivedAt: number }
  | { type: 'peer-heartbeat'; heartbeat: Heartbeat; serverReceivedAt: number }
  | { type: 'peer-chat'; text: string; name: string; serverReceivedAt: number }
  | { type: 'room-ended' }
  | { type: 'room-full' }
  | { type: 'error'; message: string };

/** Hard product rule: a Eigakan room holds exactly two viewers. */
export const MAX_PEERS_PER_ROOM = 2;

/** Drift beyond this many seconds is corrected with a seek; below it, rate nudges are enough. */
export const DRIFT_SEEK_THRESHOLD_SECONDS = 1.5;

/** Drift above this (but below the seek threshold) is corrected by a temporary rate change. */
export const DRIFT_RATE_THRESHOLD_SECONDS = 0.3;
