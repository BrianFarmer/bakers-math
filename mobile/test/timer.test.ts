import { describe, expect, it } from 'vitest';
import { addTime, describeSeconds, formatDuration, newTimer, parseHhMm, pause, remainingMs, settle, start, toHhMm } from '../src/lib/timer';

describe('timers', () => {
  it('runs from an absolute end time, so time away is counted', () => {
    let t = start(newTimer(30 * 60), 1_000);
    expect(t.endsAt).toBe(1_000 + 30 * 60_000);
    // The app was closed for ten minutes.
    expect(remainingMs(t, 1_000 + 10 * 60_000)).toBe(20 * 60_000);
    t = settle(t, 1_000 + 31 * 60_000);
    expect(t.status).toBe('finished');
  });

  it('pauses, resumes and adds five minutes', () => {
    let t = start(newTimer(600), 0);
    t = pause(t, 100_000);
    expect(t.status).toBe('paused');
    expect(remainingMs(t, 999_999)).toBe(500_000);
    t = addTime(t, 5 * 60_000, 200_000);
    expect(remainingMs(t, 200_000)).toBe(800_000);
    t = start(t, 300_000);
    expect(t.endsAt).toBe(1_100_000);
    expect(t.startedAt).toBe(0);
  });

  it('+5 min on a finished timer starts it again', () => {
    let t = settle(start(newTimer(60), 0), 61_000);
    t = addTime(t, 300_000, 70_000);
    expect(t.status).toBe('running');
    expect(t.endsAt).toBe(370_000);
  });

  it('formats and parses durations', () => {
    expect(formatDuration(3_909_000)).toBe('1:05:09');
    expect(formatDuration(247_000)).toBe('4:07');
    expect(describeSeconds(14_400)).toBe('4 h');
    expect(describeSeconds(5_400)).toBe('1 h 30 min');
    expect(parseHhMm('0:30')).toBe(1800);
    expect(parseHhMm('4:00')).toBe(14_400);
    expect(parseHhMm('45')).toBe(2700);
    expect(parseHhMm('')).toBeNull();
    expect(parseHhMm('1:75')).toBeNull();
    expect(toHhMm(5400)).toBe('1:30');
  });
});
