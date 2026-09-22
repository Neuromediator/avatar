/**
 * Visitor session state: the conversation id (cookie `avatar_cid`), the
 * "Keep chat" preference (localStorage `avatar-keep`, default on) and the
 * optional visitor name (localStorage `avatar-name`).
 *
 * Keep chat ON  -> reuse the cookie id when present (and restore that thread);
 *                  a fresh id is written to the cookie.
 * Keep chat OFF -> a fresh id on every page load; the cookie is removed.
 */
import {
  CID_COOKIE,
  STORAGE_KEYS,
  deleteCookie,
  getCookie,
  isUuid,
  newConversationId,
  setCookie,
  storageGet,
  storageSet,
} from '../shared/storage';

/** Max length of the visitor name (matches the backend's clamp). */
export const NAME_MAX = 60;

/** The visitor name as sent to the backend: trimmed, max 60 chars, empty -> null. */
export function normalizeName(raw: string | null | undefined): string | null {
  const name = (raw ?? '').trim().slice(0, NAME_MAX).trim();
  return name ? name : null;
}

export class VisitorSession {
  /** Current conversation id (a UUID). */
  id: string;
  /** Keep chat preference. */
  keep: boolean;
  /** True when the id came from the cookie (a kept chat to restore). */
  readonly restored: boolean;

  constructor() {
    this.keep = storageGet(STORAGE_KEYS.keep) !== '0';
    const fromCookie = getCookie(CID_COOKIE);
    if (this.keep && isUuid(fromCookie)) {
      this.id = fromCookie.toLowerCase();
      this.restored = true;
    } else {
      this.id = newConversationId();
      this.restored = false;
    }
    this.persistId();
  }

  /** Write (Keep chat on) or remove (off) the conversation cookie. */
  private persistId(): void {
    if (this.keep) setCookie(CID_COOKIE, this.id);
    else deleteCookie(CID_COOKIE);
  }

  /** Toggle Keep chat. The current conversation stays on screen either way. */
  setKeep(keep: boolean): void {
    this.keep = keep;
    storageSet(STORAGE_KEYS.keep, keep ? '1' : '0');
    this.persistId();
  }

  /** Start a new conversation (Reset). Returns the new id. */
  reset(): string {
    this.id = newConversationId();
    this.persistId();
    return this.id;
  }

  /** The stored visitor name ('' when none). */
  static loadName(): string {
    return storageGet(STORAGE_KEYS.name) ?? '';
  }

  /** Persist the visitor name field value. */
  static saveName(value: string): void {
    storageSet(STORAGE_KEYS.name, value.slice(0, NAME_MAX));
  }
}
