/**
 * Browser persistence helpers. Every localStorage access is wrapped in
 * try/catch (private mode, blocked site data, sandboxed iframes), and the
 * visitor's conversation id lives in a first-party cookie.
 */

/** localStorage keys used by the app. */
export const STORAGE_KEYS = {
  theme: 'avatar-theme', // "dark" | "light" (default dark)
  keep: 'avatar-keep',   // "1" | "0" (default "1")
  name: 'avatar-name',   // the visitor's name / initials field
} as const;

/** Cookie holding the visitor's conversation id. */
export const CID_COOKIE = 'avatar_cid';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** localStorage.getItem, or null when unavailable. */
export function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** localStorage.setItem; silently ignored when unavailable. */
export function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/** localStorage.removeItem; silently ignored when unavailable. */
export function storageRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

/** Read a cookie by name (null when absent or cookies are unavailable). */
export function getCookie(name: string): string | null {
  try {
    const prefix = `${encodeURIComponent(name)}=`;
    for (const part of document.cookie.split(';')) {
      const c = part.trim();
      if (c.startsWith(prefix)) return decodeURIComponent(c.slice(prefix.length));
    }
  } catch {
    /* cookies unavailable */
  }
  return null;
}

/** Set a cookie: Path=/, SameSite=Lax, Secure on https. */
export function setCookie(name: string, value: string, maxAgeSeconds = ONE_YEAR_SECONDS): void {
  try {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/; SameSite=Lax${secure}`;
  } catch {
    /* cookies unavailable */
  }
}

/** Delete a cookie set by {@link setCookie}. */
export function deleteCookie(name: string): void {
  setCookie(name, '', 0);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True for a canonical UUID string (what the backend's UUID path param accepts). */
export function isUuid(value: string | null | undefined): value is string {
  return !!value && UUID_RE.test(value);
}

/**
 * A fresh random v4 UUID for a conversation id. Uses crypto.randomUUID when
 * available (secure contexts) and falls back to crypto.getRandomValues.
 */
export function newConversationId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
