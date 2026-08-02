/**
 * Display formatters.
 *
 * PRIVACY: there is deliberately no coordinate formatter in this module, and
 * there must never be one. A latitude/longitude pair is renderable in exactly
 * one place in this app — the map surface itself (spec §20). If you find
 * yourself wanting `formatCoordinate()`, the answer is a place name, a distance,
 * or nothing at all.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function secondsBetween(fromIso: string, nowMs: number): number {
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((nowMs - from) / 1000));
}

/**
 * "Just now" / "4 min ago" / "3 h ago" / "2 d ago".
 * Intentionally coarse: an exact timestamp beside a map pin is a pattern-of-life
 * detail we do not need to expose.
 */
export function formatRelativeTime(iso: string | null, nowMs: number): string {
  if (iso === null) return 'Never';
  const seconds = secondsBetween(iso, nowMs);
  if (!Number.isFinite(seconds)) return 'Unknown';
  if (seconds < 45) return 'Just now';
  if (seconds < HOUR) return `${Math.round(seconds / MINUTE)} min ago`;
  if (seconds < DAY) {
    const hours = Math.round(seconds / HOUR);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  const days = Math.round(seconds / DAY);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** mm:ss, used by the live-session countdown. */
export function formatCountdown(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / MINUTE);
  const seconds = clamped % MINUTE;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** "10 minutes" / "45 seconds" — for describing a session length in prose. */
export function formatDuration(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  if (clamped < MINUTE) return `${clamped} second${clamped === 1 ? '' : 's'}`;
  const minutes = Math.round(clamped / MINUTE);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function formatBatteryLevel(level: number | null): string {
  if (level === null) return 'Battery unknown';
  return `${Math.round(level * 100)}%`;
}

/** Geofence radius, shown to the person editing a place. Not a position. */
export function formatRadius(meters: number): string {
  if (meters >= 1000) {
    const km = meters / 1000;
    return `${km % 1 === 0 ? km.toFixed(0) : km.toFixed(1)} km`;
  }
  return `${Math.round(meters)} m`;
}

export function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

/** Local calendar day key, `YYYY-MM-DD`, used for history day selection. */
export function toDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addDays(date: Date, delta: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + delta);
  return next;
}

/**
 * Most-recent-first list of day keys, capped by the plan's retention window so
 * the picker can never offer a day the user is not entitled to read.
 */
export function recentDayKeys(nowMs: number, retentionDays: number): string[] {
  const days = Math.max(0, Math.floor(retentionDays));
  const today = new Date(nowMs);
  const keys: string[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    keys.push(toDayKey(addDays(today, -offset)));
  }
  return keys;
}

export function formatDayLabel(dayKey: string, nowMs: number): string {
  const todayKey = toDayKey(new Date(nowMs));
  const yesterdayKey = toDayKey(addDays(new Date(nowMs), -1));
  if (dayKey === todayKey) return 'Today';
  if (dayKey === yesterdayKey) return 'Yesterday';
  const parts = dayKey.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return dayKey;
  }
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatClockTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '--:--';
  return new Date(parsed).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Two-letter monogram for an avatar placeholder. */
export function initialsOf(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  const second = words[1];
  if (first === undefined) return '?';
  if (second === undefined) return first.slice(0, 2).toUpperCase();
  return `${first.slice(0, 1)}${second.slice(0, 1)}`.toUpperCase();
}
