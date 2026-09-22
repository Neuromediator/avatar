/**
 * What three-way.e2e.spec.ts saves for restart.e2e.spec.ts: the run's
 * conversation ids and each participant's browser storage (cookies +
 * localStorage), so the same "browsers" can come back after the container is
 * restarted. Kept outside the repo (OS temp dir), readable only by the owner of
 * the file - it holds an admin session cookie. Delete it after the restart check.
 */
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext } from '@playwright/test';

export const THREE_WAY_STATE_FILE = process.env.THREE_WAY_STATE_FILE
  || path.join(os.tmpdir(), 'avatar-three-way-state.json');

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

export interface ThreeWayState {
  saved_at: string;
  base_url: string;
  conversation_ids: { alice: string; bob: string; chen: string };
  names: { alice: string; bob: string; chen: string };
  human_to_alice: string;
  human_to_chen: string;
  row_counts: { alice: number; bob: number; chen: number };
  storage: { alice: StorageState; bob: StorageState; chen: StorageState; admin: StorageState };
}
