/**
 * Small admin-only helpers: display names, time labels, the "Avatar asked for
 * you" rule, the locally remembered "Mark resolved" state and layout queries.
 */
import type { AdminMessage, ConversationSummary, PublicMessage } from '../shared/api';
import { formatMessageTime, isSameDay, parseTimestamp } from '../shared/format';
import { storageGet, storageSet } from '../shared/storage';

/** Below this width the dashboard is a master/detail flow (SPEC: admin on mobile). */
export const MOBILE_QUERY = '(max-width: 820px)';

export function isMobileLayout(): boolean {
  return typeof matchMedia === 'function' && matchMedia(MOBILE_QUERY).matches;
}

/** True on touch-first devices (no hover, coarse pointer) - avoids popping the keyboard. */
export { isTouchDevice } from '../shared/dom';

/** Row / thread display name: the visitor's name, or "Visitor · 3f2a" (first 4 hex of the id). */
export function displayName(conversationId: string, name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (trimmed) return trimmed;
  const hex = conversationId.replace(/[^0-9a-f]/gi, '').slice(0, 4).toLowerCase();
  return `Visitor · ${hex}`;
}

/**
 * Short name for the composer placeholder: "Jordan" (from "Jordan M."), the
 * whole name when the first word is only an initial ("T. Rivera", "S.K"), or
 * "the visitor". A trailing period is dropped so "…" reads cleanly.
 */
export function composerTarget(name: string | null | undefined): string {
  const full = (name ?? '').trim().replace(/\s+/g, ' ');
  if (!full) return 'the visitor';
  const first = full.split(' ')[0]!;
  const letters = first.replace(/[^\p{L}\p{N}]/gu, '');
  const pick = letters.length >= 2 && !first.includes('.') ? first : full;
  return pick.replace(/\.+$/, '') || 'the visitor';
}

/** "2:41 PM" today, otherwise "Sep 12, 2:41 PM" (plus the year when not this year). */
export function startedLabel(iso: string, now: Date = new Date()): string {
  const d = parseTimestamp(iso);
  if (isSameDay(d, now)) return formatMessageTime(d);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return `${d.toLocaleDateString('en-US', opts)}, ${formatMessageTime(d)}`;
}

/** Sort key for "most recent activity first". */
export function activityTime(s: ConversationSummary): number {
  const t = parseTimestamp(s.last_message_at).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** True when the message is an avatar reply that called push_tool (the Avatar notified the owner). */
export function isPushMessage(m: PublicMessage): boolean {
  return m.role === 'avatar'
    && Array.isArray(m.tool_calls)
    && m.tool_calls.some((t) => t.type === 'function' && t.name === 'push_tool');
}

/**
 * The "Avatar asked for you" rule for an open thread: the latest push_tool
 * call is not yet followed by a message from the owner, and it is newer than
 * the last time the owner pressed "Mark resolved" on this conversation.
 */
export function hasPendingPush(messages: readonly AdminMessage[], resolvedUpTo: number): boolean {
  let lastPush = -1;
  let lastHuman = -1;
  for (const m of messages) {
    if (m.role === 'human' && m.id > lastHuman) lastHuman = m.id;
    if (isPushMessage(m) && m.id > lastPush) lastPush = m.id;
  }
  return lastPush > lastHuman && lastPush > resolvedUpTo;
}

// ---- "Mark resolved" memory (per browser) -----------------------------------
// The server clears needs_attention when a thread is opened; this remembers the
// highest message id the owner has explicitly resolved, so the in-thread flag
// stays down after a reload.

const RESOLVED_KEY = 'avatar-admin-resolved';
const RESOLVED_MAX_ENTRIES = 300;

function readResolved(): Record<string, number> {
  const raw = storageGet(RESOLVED_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, number>;
  } catch {
    /* corrupted - start over */
  }
  return {};
}

export function getResolvedUpTo(conversationId: string): number {
  const v = readResolved()[conversationId];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function setResolvedUpTo(conversationId: string, messageId: number): void {
  const map = readResolved();
  delete map[conversationId];
  map[conversationId] = messageId; // re-insert last = most recent
  const keys = Object.keys(map);
  for (const k of keys.slice(0, Math.max(0, keys.length - RESOLVED_MAX_ENTRIES))) delete map[k];
  storageSet(RESOLVED_KEY, JSON.stringify(map));
}
