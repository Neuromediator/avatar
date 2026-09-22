/**
 * Admin entry point (/admin): session check -> login gate or dashboard.
 * Any 401 later on returns to the gate; signing out does too.
 */
import { ApiError, UnauthorizedError, getAdminSession, type AppConfig } from '../shared/api';
import { bootstrap } from '../shared/boot';
import { $ } from '../shared/dom';
import { Dashboard } from './dashboard';
import { mountGate, type GateHandle } from './gate';

let gate: GateHandle | null = null;
let dashboard: Dashboard | null = null;

function teardown(): void {
  gate?.destroy();
  gate = null;
  dashboard?.destroy();
  dashboard = null;
}

function showGate(root: HTMLElement, cfg: AppConfig, notice: string | null = null): void {
  teardown();
  gate = mountGate(root, cfg, {
    notice,
    onSuccess: () => showDashboard(root, cfg),
  });
}

function showDashboard(root: HTMLElement, cfg: AppConfig): void {
  teardown();
  dashboard = new Dashboard({
    cfg,
    onUnauthorized: () => showGate(root, cfg, 'Your session has ended. Sign in again to continue.'),
    onSignedOut: () => showGate(root, cfg),
  });
  dashboard.mount(root);
}

async function start(): Promise<void> {
  const cfg = await bootstrap();
  const root = $<HTMLElement>('#app');
  try {
    await getAdminSession();
    showDashboard(root, cfg);
  } catch (err) {
    if (err instanceof UnauthorizedError) showGate(root, cfg);
    else showGate(root, cfg, err instanceof ApiError ? err.detail : "Couldn't reach the server.");
  } finally {
    root.removeAttribute('aria-busy');
  }
}

void start();
