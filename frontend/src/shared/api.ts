/**
 * Typed client for every backend endpoint in the architecture contract.
 *
 * - All requests use `credentials: 'same-origin'` (the admin session is an
 *   httpOnly cookie; visitors are addressed only by their conversation id).
 * - Failures throw typed errors:
 *     HTTP 429           -> RateLimitedError (server's friendly detail + retryAfter)
 *     HTTP 401           -> UnauthorizedError
 *     other HTTP errors  -> ApiError(status, detail)
 *     network failure    -> ApiError(0, friendly detail)
 *     aborted            -> the original AbortError (check with isAbortError)
 * - POST /api/chat is Server-Sent Events over fetch: {@link streamChat} yields
 *   typed {@link ChatEvent}s parsed by {@link parseSSE}.
 */

// ---------------------------------------------------------------------------
// Types (mirror the backend contract)
// ---------------------------------------------------------------------------

export type Role = 'visitor' | 'avatar' | 'human';

/** A function tool call recorded on an avatar row (output truncated to 2000 chars). */
export interface FunctionToolCall {
  type: 'function';
  name: string;
  /** JSON-encoded arguments string, e.g. '{"question_number": 12}'. */
  arguments: string;
  output: string;
}

/** Marker stored on avatar rows produced by the `Qn` instant-answer shortcut. */
export interface InstantToolCall {
  type: 'instant';
  faq: number;
}

export type ToolCallEntry = FunctionToolCall | InstantToolCall;

/** A message as the visitor sees it. Never includes read / needs_attention. */
export interface PublicMessage {
  id: number;
  role: Role;
  content: string;
  /** ISO-8601 timestamp. */
  created_at: string;
  tool_calls: ToolCallEntry[] | null;
}

/** A message as the admin sees it. */
export interface AdminMessage extends PublicMessage {
  needs_attention: boolean;
  read: boolean;
}

/** GET /api/conversations/{id} */
export interface ConversationResponse {
  conversation_id: string;
  /** May be null on `after_id` polls - clients ignore a null name there. */
  conversation_name: string | null;
  messages: PublicMessage[];
}

/** GET /admin/api/conversations/{id} */
export interface AdminConversationResponse {
  conversation_id: string;
  conversation_name: string | null;
  messages: AdminMessage[];
}

/** One inbox row from GET /admin/api/conversations. */
export interface ConversationSummary {
  conversation_id: string;
  conversation_name: string | null;
  started_at: string;
  last_message_at: string;
  message_count: number;
  unread_count: number;
  needs_attention: boolean;
  /** Latest visitor message (first 140 chars); fallback: latest message of any role. */
  preview: string;
  last_role: Role;
}

/** GET /api/config */
export interface AppConfig {
  owner_name: string;
  owner_first_name: string;
}

/** GET /admin/api/session */
export interface AdminSession {
  authenticated: true;
  owner_name: string;
}

/** POST /api/chat body. */
export interface ChatRequest {
  conversation_id: string;
  message: string;
  name: string | null;
}

/** Typed SSE events from POST /api/chat, in stream order. */
export type ChatEvent =
  | { type: 'start'; visitor_message: PublicMessage }
  | { type: 'instant'; faq: number }
  | { type: 'tool_called'; call_id: string; name: string; arguments: string }
  /** `ok` is sent for push_tool only: false when the notification was not delivered. */
  | { type: 'tool_output'; call_id: string; name: string; ok?: boolean }
  | { type: 'delta'; text: string }
  | { type: 'done'; message: PublicMessage }
  | { type: 'error'; detail: string };

export type ChatEventType = ChatEvent['type'];

/** A raw SSE event as parsed off the wire. */
export interface RawSSEEvent {
  /** The `event:` field ("message" when absent). */
  event: string;
  /** All `data:` lines joined with "\n". */
  data: string;
  /** The `id:` field, if any. */
  id?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Any failed API call. `status` is 0 for network failures / interrupted streams. */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

/** HTTP 429 from POST /api/chat. `detail` is the server's friendly message. */
export class RateLimitedError extends ApiError {
  /** Seconds from the Retry-After header, when present. */
  readonly retryAfter: number | null;
  constructor(detail: string, retryAfter: number | null) {
    super(429, detail);
    this.name = 'RateLimitedError';
    this.retryAfter = retryAfter;
  }
}

/** HTTP 401 (admin session missing/expired, or a wrong password at login). */
export class UnauthorizedError extends ApiError {
  constructor(detail = 'Not authenticated') {
    super(401, detail);
    this.name = 'UnauthorizedError';
  }
}

/** The chat stream closed before a terminal `done`/`error` event (e.g. connection dropped). */
export class StreamInterruptedError extends ApiError {
  constructor(detail = 'The connection was interrupted before the reply finished.') {
    super(0, detail);
    this.name = 'StreamInterruptedError';
  }
}

/** Friendly default for the 429 case if the server sent no detail. */
export const RATE_LIMIT_MESSAGE = "You're sending messages too quickly. Please wait a moment and try again.";
const NETWORK_MESSAGE = "Couldn't reach the server. Check your connection and try again.";

/** True for an aborted fetch / stream (AbortController.abort()). */
export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

// ---------------------------------------------------------------------------
// Core request plumbing
// ---------------------------------------------------------------------------

export interface RequestOptions {
  signal?: AbortSignal;
}

/** Pull a human-readable message out of a FastAPI error body. */
function extractDetail(body: unknown, status: number): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
    if (Array.isArray(detail)) {
      const msgs = detail
        .map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : ''))
        .filter(Boolean);
      if (msgs.length) return msgs.join('; ');
    }
  }
  if (status === 404) return 'Not found.';
  if (status >= 500) return 'Something went wrong on the server. Please try again.';
  return `Request failed (HTTP ${status}).`;
}

function parseRetryAfter(res: Response): number | null {
  const raw = res.headers.get('Retry-After');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, Math.round((at - Date.now()) / 1000));
}

/** Convert a non-OK response into the right typed error. */
async function toError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (res.status === 429) {
    const detail = body && typeof body === 'object' && typeof (body as { detail?: unknown }).detail === 'string'
      ? (body as { detail: string }).detail
      : RATE_LIMIT_MESSAGE;
    return new RateLimitedError(detail, parseRetryAfter(res));
  }
  const detail = extractDetail(body, res.status);
  if (res.status === 401) return new UnauthorizedError(detail);
  return new ApiError(res.status, detail);
}

async function send(url: string, init: RequestInit & RequestOptions): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin', ...init });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ApiError(0, NETWORK_MESSAGE);
  }
  if (!res.ok) throw await toError(res);
  return res;
}

async function getJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: opts.signal,
  });
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const res = await send(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: opts.signal,
  });
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** GET /api/config - owner name for UI copy. No DB hit. */
export function getConfig(opts?: RequestOptions): Promise<AppConfig> {
  return getJson<AppConfig>('/api/config', opts);
}

/**
 * GET /api/conversations/{id}[?after_id=N] - the visitor's thread (or only rows
 * with id > afterId). Unknown conversation -> empty `messages`.
 */
export function getConversation(
  conversationId: string,
  afterId?: number | null,
  opts?: RequestOptions,
): Promise<ConversationResponse> {
  const qs = afterId !== undefined && afterId !== null ? `?after_id=${enc(String(afterId))}` : '';
  return getJson<ConversationResponse>(`/api/conversations/${enc(conversationId)}${qs}`, opts);
}

/**
 * POST /api/chat - send a visitor message and stream the reply.
 *
 *   try {
 *     for await (const ev of streamChat({ conversation_id, message, name })) {
 *       switch (ev.type) { case 'delta': bubble.appendDelta(ev.text); break; ... }
 *     }
 *   } catch (e) {
 *     if (e instanceof RateLimitedError) showNotice(e.detail);      // HTTP 429, nothing stored
 *     else if (e instanceof StreamInterruptedError) ...             // reply still lands in the DB; poll picks it up
 *     else if (e instanceof ApiError) ...
 *   }
 *
 * Throws before yielding anything for HTTP errors (429/422/5xx). Ends normally
 * after a `done` or `error` event; throws StreamInterruptedError if the stream
 * closes without one.
 */
export async function* streamChat(req: ChatRequest, opts: RequestOptions = {}): AsyncGenerator<ChatEvent, void, void> {
  const res = await send('/api/chat', {
    method: 'POST',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    cache: 'no-store',
    signal: opts.signal,
  });
  if (!res.body) throw new StreamInterruptedError();
  let terminal = false;
  try {
    for await (const raw of parseSSE(res.body)) {
      const ev = toChatEvent(raw);
      if (!ev) continue;
      yield ev;
      if (ev.type === 'done' || ev.type === 'error') {
        terminal = true;
        return;
      }
    }
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new StreamInterruptedError();
  }
  if (!terminal) throw new StreamInterruptedError();
}

const CHAT_EVENT_TYPES: ReadonlySet<string> = new Set<ChatEventType>([
  'start', 'instant', 'tool_called', 'tool_output', 'delta', 'done', 'error',
]);

/** Map a raw SSE event to a typed ChatEvent (null for unknown types / bad JSON). */
export function toChatEvent(raw: RawSSEEvent): ChatEvent | null {
  if (!CHAT_EVENT_TYPES.has(raw.event)) return null;
  let data: unknown;
  try {
    data = raw.data ? JSON.parse(raw.data) : {};
  } catch {
    console.warn('[avatar] ignoring malformed SSE data for event', raw.event);
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  return { ...(data as object), type: raw.event } as ChatEvent;
}

/**
 * Parse a Server-Sent Events byte stream (WHATWG event-stream rules):
 * robust to arbitrary chunk boundaries (including a CRLF split across chunks
 * and multi-byte UTF-8), LF / CR / CRLF line endings, multi-line `data:`,
 * comment lines (":"), and an optional single space after the colon. A final
 * event without a trailing blank line is still dispatched.
 */
export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<RawSSEEvent, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let eventType = '';
  let dataLines: string[] = [];
  let lastId: string | undefined;

  const dispatch = (): RawSSEEvent | null => {
    if (dataLines.length === 0) {
      eventType = '';
      return null;
    }
    const ev: RawSSEEvent = { event: eventType || 'message', data: dataLines.join('\n') };
    if (lastId !== undefined) ev.id = lastId;
    eventType = '';
    dataLines = [];
    return ev;
  };

  const processLine = (line: string): RawSSEEvent | null => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventType = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id' && !value.includes('\0')) lastId = value;
    return null;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Hold back a trailing "\r": it may be the first half of a CRLF.
      let holdCR = false;
      if (buffer.endsWith('\r')) {
        holdCR = true;
        buffer = buffer.slice(0, -1);
      }
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = (lines.pop() ?? '') + (holdCR ? '\r' : '');
      for (const line of lines) {
        const ev = processLine(line);
        if (ev) yield ev;
      }
    }
    buffer += decoder.decode();
    if (buffer.length) {
      for (const line of buffer.split(/\r\n|\r|\n/)) {
        const ev = processLine(line);
        if (ev) yield ev;
      }
    }
    const tail = dispatch();
    if (tail) yield tail;
  } finally {
    // Also runs when the consumer stops early: close the connection.
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    reader.releaseLock();
  }
}

// ---- Admin ----------------------------------------------------------------

/** POST /admin/login - sets the httpOnly session cookie. Wrong password -> UnauthorizedError("Invalid password"). */
export async function adminLogin(password: string, opts?: RequestOptions): Promise<void> {
  await postJson<{ ok: true }>('/admin/login', { password }, opts);
}

/** POST /admin/logout - clears the session cookie (never fails on auth). */
export async function adminLogout(opts?: RequestOptions): Promise<void> {
  await postJson<{ ok: true }>('/admin/logout', undefined, opts);
}

/** GET /admin/api/session - resolves when logged in; UnauthorizedError otherwise. */
export function getAdminSession(opts?: RequestOptions): Promise<AdminSession> {
  return getJson<AdminSession>('/admin/api/session', opts);
}

/** GET /admin/api/conversations - inbox, most recent activity first. */
export async function listConversations(opts?: RequestOptions): Promise<ConversationSummary[]> {
  const res = await getJson<{ conversations: ConversationSummary[] }>('/admin/api/conversations', opts);
  return res.conversations;
}

/**
 * GET /admin/api/conversations/{id} - opens the thread: marks every row read
 * and clears needs_attention server-side, returning the updated rows.
 * Unknown id -> ApiError(404, "Conversation not found").
 */
export function openConversation(conversationId: string, opts?: RequestOptions): Promise<AdminConversationResponse> {
  return getJson<AdminConversationResponse>(`/admin/api/conversations/${enc(conversationId)}`, opts);
}

/** POST /admin/api/conversations/{id}/messages - the owner posts as the human. The Avatar does not react. */
export async function postHumanMessage(conversationId: string, content: string, opts?: RequestOptions): Promise<AdminMessage> {
  const res = await postJson<{ message: AdminMessage }>(
    `/admin/api/conversations/${enc(conversationId)}/messages`,
    { content },
    opts,
  );
  return res.message;
}

/** POST /admin/api/conversations/{id}/resolve - clears needs_attention without replying. */
export async function resolveConversation(conversationId: string, opts?: RequestOptions): Promise<void> {
  await postJson<{ ok: true }>(`/admin/api/conversations/${enc(conversationId)}/resolve`, undefined, opts);
}
