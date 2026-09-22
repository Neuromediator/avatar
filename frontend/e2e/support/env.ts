/**
 * Test environment: paths, the admin password (never printed), the owner
 * config (always read from the running server's /api/config - never
 * hardcoded) and the FAQ file (to compare instant answers against).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext } from '@playwright/test';

export const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_DIR = path.resolve(FRONTEND_DIR, '..');

export const SCREENSHOT_DIR = process.env.AVATAR_SCREENSHOT_DIR
  || path.resolve(FRONTEND_DIR, process.env.SCREENSHOT_DIR || '../test/screenshots/frontend');

/** A setting from the environment, else from the repo's .env ('' when absent). Values are never logged. */
export function envValue(name: string): string {
  let value = process.env[name] ?? '';
  if (!value) {
    const envFile = path.join(REPO_DIR, '.env');
    if (fs.existsSync(envFile)) {
      const re = new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`);
      for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
        const m = re.exec(line);
        if (m) value = m[1]!.replace(/^(['"])(.*)\1$/, '$2');
      }
    }
  }
  return value;
}

let cachedPassword: string | null = null;

/** ADMIN_PASSWORD from the environment, else from the repo's .env (value is never logged). */
export function adminPassword(): string {
  if (cachedPassword) return cachedPassword;
  const value = envValue('ADMIN_PASSWORD');
  if (!value) throw new Error('ADMIN_PASSWORD is not set (env or ../.env)');
  cachedPassword = value;
  return value;
}

export interface OwnerConfig {
  owner_name: string;
  owner_first_name: string;
}

let cachedConfig: OwnerConfig | null = null;

/** The owner config from the server under test (GET /api/config). */
export async function ownerConfig(request: APIRequestContext): Promise<OwnerConfig> {
  if (cachedConfig) return cachedConfig;
  const res = await request.get('/api/config');
  if (!res.ok()) throw new Error(`/api/config -> ${res.status()}`);
  cachedConfig = (await res.json()) as OwnerConfig;
  return cachedConfig;
}

export interface FaqRow {
  faq: number;
  question: string;
  answer: string;
  query: string;
}

let cachedFaq: Map<number, FaqRow> | null = null;

/** knowledge/faq.jsonl keyed by FAQ number. */
export function faqs(): Map<number, FaqRow> {
  if (cachedFaq) return cachedFaq;
  const rows = fs.readFileSync(path.join(REPO_DIR, 'knowledge', 'faq.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as FaqRow);
  cachedFaq = new Map(rows.map((r) => [r.faq, r]));
  return cachedFaq;
}

/** A unique visitor name that starts with "TEST" (so test threads are easy to find and clean up). */
export function testName(tag: string): string {
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `TEST ${tag} ${rand}`;
}

/** A fresh random conversation id (UUID v4). */
export function newCid(): string {
  return crypto.randomUUID();
}

/** The initials the UI derives from a name: first letter of the first and last words (e.g. "TEST Thread K2" -> "TK"). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
}
