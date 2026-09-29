/**
 * Step timers. A running timer is stored as an absolute end time, so leaving the app (or the
 * phone restarting the JS runtime) never loses time: reopening just recomputes what's left.
 */

export type TimerStatus = 'idle' | 'running' | 'paused' | 'finished';

export interface TimerState {
  status: TimerStatus;
  /** Epoch ms when a running timer ends. */
  endsAt: number | null;
  /** Time left when not running. */
  remainingMs: number;
  /** When the timer was first started (for the bake log). */
  startedAt: number | null;
}

export function newTimer(durationSeconds: number): TimerState {
  return { status: 'idle', endsAt: null, remainingMs: durationSeconds * 1000, startedAt: null };
}

export function remainingMs(t: TimerState, now: number): number {
  if (t.status === 'running' && t.endsAt !== null) return Math.max(0, t.endsAt - now);
  if (t.status === 'finished') return 0;
  return Math.max(0, t.remainingMs);
}

/** Turns a running timer whose end time has passed into a finished one. */
export function settle(t: TimerState, now: number): TimerState {
  if (t.status === 'running' && t.endsAt !== null && t.endsAt <= now) {
    return { ...t, status: 'finished', remainingMs: 0 };
  }
  return t;
}

export function start(t: TimerState, now: number): TimerState {
  if (t.status === 'running' || t.status === 'finished') return t;
  return { status: 'running', endsAt: now + t.remainingMs, remainingMs: t.remainingMs, startedAt: t.startedAt ?? now };
}

export function pause(t: TimerState, now: number): TimerState {
  const s = settle(t, now);
  if (s.status !== 'running') return s;
  return { ...s, status: 'paused', endsAt: null, remainingMs: remainingMs(s, now) };
}

/** Adds time (the +5 min button). A finished timer comes back to life, running. */
export function addTime(t: TimerState, ms: number, now: number): TimerState {
  const s = settle(t, now);
  if (s.status === 'running') return { ...s, endsAt: s.endsAt! + ms };
  if (s.status === 'finished') return { ...s, status: 'running', endsAt: now + ms, remainingMs: ms };
  return { ...s, remainingMs: s.remainingMs + ms };
}

/** "1:05:09", "4:07" or "0:30". */
export function formatDuration(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "4 h", "1 h 30 min", "45 min", "90 s": for step lists. */
export function describeSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}

/** Parses the editor's "h:mm" (or plain minutes) into seconds; empty means no timer. */
export function parseHhMm(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const m = /^(\d+):([0-5]?\d)$/.exec(t);
  if (m) {
    const secs = Number(m[1]) * 3600 + Number(m[2]) * 60;
    return secs > 0 ? secs : null;
  }
  if (/^\d+$/.test(t)) {
    const secs = Number(t) * 60;
    return secs > 0 ? secs : null;
  }
  return null;
}

export function toHhMm(seconds: number | null): string {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}
