/**
 * One-call page bootstrap shared by both screens. Call it first in each
 * screen's main.ts:
 *
 *   const cfg = await bootstrap();   // { owner_name, owner_first_name }
 *
 * It injects the inline icon sprite, applies the stored theme (dark default)
 * and loads the owner config, replacing any {{OWNER_NAME}} /
 * {{OWNER_FIRST_NAME}} placeholders still present (under `vite dev`).
 * Never rejects (config falls back gracefully).
 */
import { injectIconSprite } from './dom';
import { initTheme } from './theme';
import { initConfig, type AppConfig } from './config';

export async function bootstrap(): Promise<AppConfig> {
  injectIconSprite();
  initTheme();
  return initConfig();
}
