const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** UI/UX §8: relative under 24h ("3m ago"), otherwise "Oct 8" (year only if not the current one). */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  const diff = now - t;
  if (diff < 45_000) return 'just now';
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / MIN))}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  const d = new Date(t);
  const label = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? label : `${label}, ${d.getFullYear()}`;
}

/** Compact elapsed time for the in-progress timer: "<1m", "42m", "2h 05m", "3d 4h". */
export function elapsed(sinceIso: string, now = Date.now()): string {
  const diff = Math.max(0, now - Date.parse(sinceIso));
  if (diff < MIN) return '<1m';
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m`;
  if (diff < DAY) {
    return `${Math.floor(diff / HOUR)}h ${String(Math.floor((diff % HOUR) / MIN)).padStart(2, '0')}m`;
  }
  return `${Math.floor(diff / DAY)}d ${Math.floor((diff % DAY) / HOUR)}h`;
}

/** A calendar date (YYYY-MM-DD) as "Oct 8", or "Oct 8, 2025" outside the current year. No timezone shifts. */
export function formatDate(iso: string | null, now = new Date()): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '—';
  const label = `${MONTHS[m - 1]} ${d}`;
  return y === now.getFullYear() ? label : `${label}, ${y}`;
}
