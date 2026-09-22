/**
 * Formatting helpers: initials, timestamps (inbox / message / day separator)
 * and short conversation ids. Pure functions, no DOM.
 */

/**
 * Initials for the visitor token (max 2 chars, uppercase), or null when the
 * name has no letters/digits.
 *   "Jordan M." -> "JM", "casey" -> "CA", "jm" -> "JM", "J" -> "J", "" -> null
 */
export function initials(name: string | null | undefined): string | null {
  if (!name) return null;
  const words = name
    .trim()
    .split(/\s+/)
    .map((w) => Array.from(w.replace(/[^\p{L}\p{N}]/gu, '')))
    .filter((chars) => chars.length > 0);
  if (words.length === 0) return null;
  const first = words[0]!;
  const out = words.length === 1
    ? first.slice(0, 2).join('')
    : `${first[0]}${words[words.length - 1]![0]}`;
  return out.toLocaleUpperCase();
}

/**
 * Parse a backend ISO-8601 timestamp robustly (Supabase returns microseconds,
 * e.g. "2026-09-21T11:22:33.123456+00:00"; some engines only take 3 digits).
 */
export function parseTimestamp(iso: string): Date {
  const normalized = iso
    .trim()
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1');
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? new Date(iso) : d;
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : parseTimestamp(value);
}

/** True when both dates fall on the same local calendar day. */
export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

/** Whole local calendar days from `a` to `b` (b later -> positive). */
function dayDiff(a: Date, b: Date): number {
  const start = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const end = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((end - start) / 86_400_000);
}

/** Message clock time in the viewer's locale, e.g. "2:41 PM" (en-US) / "14:41". */
export function formatMessageTime(value: string | Date): string {
  return toDate(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Full, unambiguous timestamp for tooltips, e.g. "Mon, Sep 21, 2026, 2:41 PM". */
export function formatFullTimestamp(value: string | Date): string {
  return toDate(value).toLocaleString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

/**
 * Inbox row time: "2:45 PM" today, "Yest" yesterday, weekday ("Mon") within
 * the last 7 days, "Sep 12" older (plus the year when it is not this year).
 */
export function formatInboxTime(value: string | Date, now: Date = new Date()): string {
  const d = toDate(value);
  const diff = dayDiff(d, now);
  if (diff <= 0) return formatMessageTime(d);
  if (diff === 1) return 'Yest';
  if (diff < 7) return d.toLocaleDateString('en-US', { weekday: 'short' });
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}

/** Day label: "Today", "Yesterday", "Mon, Sep 14" (plus year if not this year). */
export function formatDayLabel(value: string | Date, now: Date = new Date()): string {
  const d = toDate(value);
  const diff = dayDiff(d, now);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}

/** Day-separator text, e.g. "Today · 2:41 PM" (time of the first message that day). */
export function formatDaySeparator(value: string | Date, now: Date = new Date()): string {
  return `${formatDayLabel(value, now)} · ${formatMessageTime(value)}`;
}

/** Local calendar-day key ("2026-09-21") used to group messages by day. */
export function dayKey(value: string | Date): string {
  const d = toDate(value);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Short, display-only conversation id: "conv_" + first 6 hex chars of the UUID. */
export function shortId(uuid: string): string {
  return `conv_${uuid.replace(/[^0-9a-f]/gi, '').slice(0, 6).toLowerCase()}`;
}

/** Truncate to `max` characters with a trailing ellipsis. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

/** "1 message" / "9 messages". */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}
