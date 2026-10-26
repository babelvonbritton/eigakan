import { describe, expect, it } from 'vitest';
import {
  decideDriftCorrection,
  generateRoomCode,
  normalizeRoomCode,
  parseVideoSource,
  parseYouTubeVideoId,
  projectEventPosition,
  projectFromServerTime,
  projectHeartbeatPosition,
  ServerClock,
  type PlaybackEvent,
} from './index';

function event(partial: Partial<PlaybackEvent>): PlaybackEvent {
  return {
    kind: 'play',
    videoTime: 100,
    sentAt: 1_000_000,
    playbackRate: 1,
    playing: true,
    ...partial,
  };
}

describe('projectEventPosition', () => {
  it('projects a playing event forward by transit time', () => {
    expect(projectEventPosition(event({}), 1_000_300)).toBeCloseTo(100.3);
  });
  it('does not project a paused event', () => {
    expect(projectEventPosition(event({ playing: false }), 1_005_000)).toBe(100);
  });
  it('scales projection by playback rate', () => {
    expect(projectEventPosition(event({ playbackRate: 2 }), 1_001_000)).toBeCloseTo(102);
  });
  it('clamps clock skew to zero', () => {
    expect(projectEventPosition(event({}), 999_000)).toBe(100);
  });
});

describe('projectHeartbeatPosition', () => {
  it('projects while playing and not while paused', () => {
    const hb = { videoTime: 50, sentAt: 2_000, playing: true, playbackRate: 1, buffering: false };
    expect(projectHeartbeatPosition(hb, 2_500)).toBeCloseTo(50.5);
    expect(projectHeartbeatPosition({ ...hb, playing: false }, 2_500)).toBe(50);
  });
});

describe('projectFromServerTime', () => {
  it('projects from the server receipt stamp, not the sender wall clock', () => {
    // Sender clock 500ms ahead of the server would have poisoned the old
    // projection; from the server stamp the same message projects cleanly.
    expect(projectFromServerTime(50, 1, true, 2_000, 2_500)).toBeCloseTo(50.5);
    expect(projectFromServerTime(50, 1, false, 2_000, 2_500)).toBe(50);
    expect(projectFromServerTime(50, 2, true, 2_000, 2_250)).toBeCloseTo(50.5);
    expect(projectFromServerTime(50, 1, true, 2_000, 1_500)).toBe(50);
  });
});

describe('ServerClock', () => {
  it('estimates the server clock from the least-delayed sample', () => {
    const clock = new ServerClock();
    expect(clock.nowEstimate(10_000)).toBeNull();
    // Two relays: one delayed 200ms, one delayed 20ms. The max sample
    // (least delay) wins, so "now" tracks the server clock closely.
    clock.observe(9_800, 10_000); // sample -200
    clock.observe(10_080, 10_100); // sample -20
    expect(clock.nowEstimate(10_200)).toBeCloseTo(10_180);
  });
  it('drops samples older than a minute', () => {
    const clock = new ServerClock();
    clock.observe(9_800, 10_000);
    clock.observe(70_080, 70_100);
    expect(clock.nowEstimate(70_200)).toBeCloseTo(70_180);
  });
});

describe('decideDriftCorrection', () => {
  it('ignores tiny drift', () => {
    expect(decideDriftCorrection(100, 100.1).action).toBe('none');
  });
  it('nudges rate when partner is moderately ahead', () => {
    const result = decideDriftCorrection(100, 101);
    expect(result.action).toBe('rate');
    if (result.action === 'rate') expect(result.suggestedRate).toBeGreaterThan(1);
  });
  it('slows down when partner is moderately behind', () => {
    const result = decideDriftCorrection(101, 100);
    expect(result.action).toBe('rate');
    if (result.action === 'rate') expect(result.suggestedRate).toBeLessThan(1);
  });
  it('seeks when drift is large (buffering stall)', () => {
    const result = decideDriftCorrection(100, 112);
    expect(result.action).toBe('seek');
    if (result.action === 'seek') expect(result.seekToSeconds).toBe(112);
  });
});

describe('room codes', () => {
  it('generates 6-char codes from the unambiguous alphabet', () => {
    const code = generateRoomCode(() => 0);
    expect(code).toBe('AAAAAA');
    expect(normalizeRoomCode(code)).toBe(code);
  });
  it('normalizes case and rejects look-alikes and bad lengths', () => {
    expect(normalizeRoomCode(' ab3kmq ')).toBe('AB3KMQ');
    expect(normalizeRoomCode('AB0KMQ')).toBeNull();
    expect(normalizeRoomCode('ABC')).toBeNull();
  });
});

describe('parseYouTubeVideoId', () => {
  it('parses watch, short, shorts and bare ids', () => {
    expect(parseYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=42')).toBe('dQw4w9WgXcQ');
    expect(parseYouTubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseYouTubeVideoId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseYouTubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });
});

describe('parseVideoSource', () => {
  it('classifies YouTube and MP4 URLs', () => {
    expect(parseVideoSource('https://youtu.be/dQw4w9WgXcQ')?.kind).toBe('youtube');
    expect(parseVideoSource('https://cdn.example.com/movie.mp4')?.kind).toBe('mp4');
    expect(parseVideoSource('https://cdn.example.com/movie/master.m3u8')?.kind).toBe('hls');
    expect(parseVideoSource('https://pub-abc.r2.dev/movie')?.kind).toBe('mp4');
    expect(parseVideoSource('https://example.com/page.html')).toBeNull();
    expect(parseVideoSource('not a url')).toBeNull();
  });
});
