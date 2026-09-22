/**
 * Talking to the real backend from tests: seeding conversations through the
 * public chat API (Qn instant answers - no LLM call), and an admin API client
 * with its own logged-in request context.
 */
import { expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { adminPassword, newCid } from './env';

export interface SseEvent {
  event: string;
  data: any;
}

/** Parse a complete text/event-stream body. */
export function parseSse(body: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) events.push({ event, data: JSON.parse(data.join('\n')) });
  }
  return events;
}

export interface ChatResult {
  status: number;
  events: SseEvent[];
  /** The `done` message (avatar row), when the stream completed. */
  done: any | null;
}

/** POST /api/chat and read the whole SSE stream. */
export async function chatViaApi(
  request: APIRequestContext,
  conversationId: string,
  message: string,
  name: string | null = null,
  timeout = 90_000,
): Promise<ChatResult> {
  const res = await request.post('/api/chat', {
    data: { conversation_id: conversationId, message, name },
    headers: { Accept: 'text/event-stream' },
    timeout,
  });
  if (res.status() !== 200) return { status: res.status(), events: [], done: null };
  const events = parseSse(await res.text());
  const done = events.find((e) => e.event === 'done')?.data?.message ?? null;
  return { status: 200, events, done };
}

/**
 * Create a conversation through the real chat API. Messages default to Qn
 * instant answers (no LLM call). Returns the conversation id.
 */
export async function seedConversation(
  request: APIRequestContext,
  opts: { name?: string | null; messages?: string[]; cid?: string } = {},
): Promise<string> {
  const cid = opts.cid ?? newCid();
  for (const msg of opts.messages ?? ['Q1']) {
    const r = await chatViaApi(request, cid, msg, opts.name ?? null);
    expect(r.status, `seed chat "${msg}"`).toBe(200);
    expect(r.done, `seed chat "${msg}" finished`).not.toBeNull();
  }
  return cid;
}

export interface AdminApi {
  ctx: APIRequestContext;
  list(): Promise<any[]>;
  summary(cid: string): Promise<any | undefined>;
  open(cid: string): Promise<any>;
  postHuman(cid: string, content: string): Promise<any>;
  resolve(cid: string): Promise<void>;
  dispose(): Promise<void>;
}

/** A separate request context signed in as the admin (POST /admin/login). */
export async function adminApi(baseURL: string): Promise<AdminApi> {
  const ctx = await playwrightRequest.newContext({ baseURL });
  const login = await ctx.post('/admin/login', { data: { password: adminPassword() } });
  expect(login.status(), 'admin login').toBe(200);
  const api: AdminApi = {
    ctx,
    async list() {
      const res = await ctx.get('/admin/api/conversations');
      expect(res.status()).toBe(200);
      return (await res.json()).conversations;
    },
    async summary(cid) {
      return (await api.list()).find((s) => s.conversation_id === cid);
    },
    async open(cid) {
      const res = await ctx.get(`/admin/api/conversations/${cid}`);
      expect(res.status()).toBe(200);
      return res.json();
    },
    async postHuman(cid, content) {
      const res = await ctx.post(`/admin/api/conversations/${cid}/messages`, { data: { content } });
      expect(res.status()).toBe(201);
      return (await res.json()).message;
    },
    async resolve(cid) {
      const res = await ctx.post(`/admin/api/conversations/${cid}/resolve`);
      expect(res.status()).toBe(200);
    },
    async dispose() {
      await ctx.dispose();
    },
  };
  return api;
}
