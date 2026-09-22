/**
 * Abuse guards end to end against the Docker container, verified in the
 * database (test/e2e_test_plan.md, section AG; SPEC "Implementation Decisions"
 * and Q&A #12):
 *   - a visitor message over 20,000 characters is truncated to 20,000 plus the
 *     exact note, and that clamped text is what is stored (and streamed back);
 *   - the 21st chat message in a minute for one conversation_id gets HTTP 429
 *     (Retry-After) and is not stored; other conversations are unaffected;
 *   - a body over 512 KiB gets HTTP 413 and nothing is stored.
 * The clamp test makes one real LLM call (openai/gpt-5.4-nano); the others use
 * Qn instant answers (no LLM call).
 */
import { expect, test } from './support/fixtures';
import { chatViaApi } from './support/api';
import { newCid } from './support/env';
import { dbRows } from './support/supabase';

test.describe.configure({ timeout: 180_000 });

const MAX_CHARS = 20_000;
const NOTE = "\n\n[...message truncated as it's too long; ask the visitor to send something more concise]";

test('a message over 20,000 characters is stored (and sent on) as 20,000 + the exact note (AG-1)', async ({ request }, testInfo) => {
  const cid = newCid();
  const filler = 'TEST clamp filler sentence number ';
  let message = '';
  for (let i = 0; message.length < 25_000; i++) message += `${filler}${i}. `;
  const r = await chatViaApi(request, cid, message, 'TEST Guard Clamp', 150_000);
  expect(r.status).toBe(200);
  const start = r.events.find((e) => e.event === 'start')!.data.visitor_message;
  const expected = message.slice(0, MAX_CHARS) + NOTE;
  expect(start.content).toBe(expected);
  expect(r.done, 'the Avatar still replied').not.toBeNull();
  const rows = await dbRows(cid);
  expect(rows.map((x) => x.role)).toEqual(['visitor', 'avatar']);
  expect(rows[0]!.content).toBe(expected);
  expect(rows[0]!.content.length).toBe(MAX_CHARS + NOTE.length);
  expect(rows[0]!.content.endsWith(NOTE)).toBe(true);
  const note = `${message.length} chars sent -> ${rows[0]!.content.length} stored; cid ${cid}`;
  testInfo.annotations.push({ type: 'clamp', description: note });
  console.log(`[guards evidence] clamp: ${note}`);
});

test('the 21st message in a minute for one conversation gets 429 and is not stored; others are unaffected (AG-2)', async ({ request }, testInfo) => {
  const cid = newCid();
  const t0 = Date.now();
  for (let i = 1; i <= 20; i++) {
    const r = await chatViaApi(request, cid, 'Q1', 'TEST Guard Rate');
    expect(r.status, `message ${i}`).toBe(200);
    expect(r.done, `message ${i} answered`).not.toBeNull();
  }
  const elapsed = Date.now() - t0;
  expect(elapsed, 'all 20 inside the one-minute window').toBeLessThan(55_000);
  const over = await request.post('/api/chat', { data: { conversation_id: cid, message: 'Q1', name: 'TEST Guard Rate' } });
  expect(over.status()).toBe(429);
  const retryAfter = Number(over.headers()['retry-after']);
  expect(retryAfter).toBeGreaterThanOrEqual(1);
  expect(retryAfter).toBeLessThanOrEqual(60);
  expect((await over.json()).detail).toMatch(/too quickly/i);
  // Still limited on an immediate retry (moving window), not stored either time.
  expect((await request.post('/api/chat', { data: { conversation_id: cid, message: 'Q2' } })).status()).toBe(429);
  const rows = await dbRows(cid);
  expect(rows).toHaveLength(40);
  expect(rows.filter((x) => x.role === 'visitor')).toHaveLength(20);
  // Another conversation is not affected.
  const other = await chatViaApi(request, newCid(), 'Q1', 'TEST Guard Rate Other');
  expect(other.status).toBe(200);
  const note = `20 accepted in ${elapsed} ms, 21st -> 429 Retry-After ${retryAfter}s; cid ${cid}`;
  testInfo.annotations.push({ type: 'rate-limit', description: note });
  console.log(`[guards evidence] rate limit: ${note}`);
});

test('a request body over 512 KiB gets 413 and nothing is stored (AG-3)', async ({ request }) => {
  const cid = newCid();
  const res = await request.post('/api/chat', {
    data: { conversation_id: cid, message: 'x'.repeat(600 * 1024), name: 'TEST Guard Big' },
  });
  expect(res.status()).toBe(413);
  expect((await res.json()).detail).toMatch(/too long/i);
  expect(await dbRows(cid)).toEqual([]);
  console.log(`[guards evidence] 413: ${600 * 1024} chars -> 413, 0 rows; cid ${cid}`);
});
