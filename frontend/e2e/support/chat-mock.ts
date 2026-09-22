/**
 * A controllable stand-in for POST /api/chat, so every stream state
 * (thinking -> tool-calling -> tool-returned -> typing -> complete / error)
 * can be held on screen and screenshotted deterministically.
 *
 * `installChatMock(page)` (before `page.goto`) wraps `window.fetch`: a POST to
 * /api/chat returns a text/event-stream Response whose body the test feeds
 * event by event with `push()`, then `close()` / `drop()`. Every other request
 * goes to the real server. The request bodies are recorded.
 */
import { expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    __chatMock: {
      requests: { conversation_id: string; message: string; name: string | null }[];
      push(event: string, data: unknown): void;
      close(): void;
      drop(): void;
    };
  }
}

export async function installChatMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    const enc = new TextEncoder();
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const current = (): ReadableStreamDefaultController<Uint8Array> => {
      const c = controllers[controllers.length - 1];
      if (!c) throw new Error('no mocked /api/chat stream is open');
      return c;
    };
    window.__chatMock = {
      requests: [],
      push(event, data) {
        current().enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      },
      close() {
        current().close();
      },
      drop() {
        current().error(new TypeError('network error'));
      },
    };
    window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method === 'POST' && new URL(url, location.href).pathname === '/api/chat') {
        window.__chatMock.requests.push(JSON.parse(String(init?.body ?? '{}')));
        let ctl!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
        controllers.push(ctl);
        return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
      }
      return realFetch(input, init);
    };
  });
}

let nextId = 9_100_000_000;

/** A PublicMessage-shaped row for mocked events. */
export function row(role: 'visitor' | 'avatar' | 'human', content: string, toolCalls: unknown[] | null = null) {
  nextId += 1;
  return { id: nextId, role, content, created_at: new Date().toISOString(), tool_calls: toolCalls };
}

export async function push(page: Page, event: string, data: unknown): Promise<void> {
  await page.evaluate(([e, d]) => window.__chatMock.push(e as string, d), [event, data] as const);
}

export async function closeStream(page: Page): Promise<void> {
  await page.evaluate(() => window.__chatMock.close());
}

export async function dropStream(page: Page): Promise<void> {
  await page.evaluate(() => window.__chatMock.drop());
}

/** Recorded /api/chat request bodies. */
export async function chatRequests(page: Page) {
  return page.evaluate(() => window.__chatMock.requests);
}

/** Wait until `n` mocked /api/chat requests were made. */
export async function waitForChatRequests(page: Page, n: number): Promise<void> {
  await expect.poll(async () => (await chatRequests(page)).length).toBe(n);
}

/** Acknowledge the latest request (the `start` event) with the visitor row. Returns the row. */
export async function ackStart(page: Page) {
  const reqs = await chatRequests(page);
  const last = reqs[reqs.length - 1]!;
  const visitor = row('visitor', last.message);
  await push(page, 'start', { visitor_message: visitor });
  return visitor;
}
