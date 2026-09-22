/**
 * Owner configuration (the person the twin represents).
 *
 * The owner's name is NEVER hardcoded in the frontend. HTML uses the literal
 * placeholders {{OWNER_NAME}} / {{OWNER_FIRST_NAME}}, which the backend
 * substitutes when serving / and /admin. Under `vite dev` (no substitution)
 * {@link applyOwnerPlaceholders} replaces them at runtime from /api/config.
 */
import { getConfig, type AppConfig } from './api';

export type { AppConfig } from './api';

export const OWNER_NAME_PLACEHOLDER = '{{OWNER_NAME}}';
export const OWNER_FIRST_NAME_PLACEHOLDER = '{{OWNER_FIRST_NAME}}';

/** Used only if both /api/config and the substituted <meta> tags are unavailable. */
const FALLBACK: AppConfig = { owner_name: 'The owner', owner_first_name: 'the owner' };

let cached: AppConfig | null = null;
let pending: Promise<AppConfig> | null = null;

function metaContent(name: string): string | null {
  const v = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content?.trim();
  return v && !v.includes('{{') ? v : null;
}

/**
 * The owner config available synchronously, without a request: from the
 * backend-substituted <meta name="avatar:owner-name"> / "avatar:owner-first-name"
 * tags (or a previous {@link loadConfig}). Null under `vite dev` before loading.
 */
export function getConfigSync(): AppConfig | null {
  if (cached) return cached;
  const name = metaContent('avatar:owner-name');
  if (!name) return null;
  return { owner_name: name, owner_first_name: metaContent('avatar:owner-first-name') ?? name.split(/\s+/)[0]! };
}

/**
 * Load GET /api/config once (memoised). Never rejects: falls back to the meta
 * tags, then to a neutral "The owner".
 */
export function loadConfig(): Promise<AppConfig> {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = getConfig()
      .then((cfg) => {
        const name = (cfg.owner_name ?? '').trim();
        const first = (cfg.owner_first_name ?? '').trim() || name.split(/\s+/)[0] || '';
        cached = name ? { owner_name: name, owner_first_name: first } : (getConfigSync() ?? FALLBACK);
        return cached;
      })
      .catch(() => {
        cached = getConfigSync() ?? FALLBACK;
        return cached;
      });
  }
  return pending;
}

function replaceAll(text: string, cfg: AppConfig): string {
  return text
    .split(OWNER_FIRST_NAME_PLACEHOLDER).join(cfg.owner_first_name)
    .split(OWNER_NAME_PLACEHOLDER).join(cfg.owner_name);
}

const PLACEHOLDER_ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'content', 'value', 'data-owner'];

/**
 * Replace {{OWNER_NAME}} / {{OWNER_FIRST_NAME}} in text nodes, common
 * attributes (placeholder, title, aria-label, alt, content, value) and
 * document.title under `root`. A no-op when the backend already substituted.
 */
export function applyOwnerPlaceholders(cfg: AppConfig, root: ParentNode = document): void {
  if (root === document && document.title.includes('{{')) {
    document.title = replaceAll(document.title, cfg);
  }
  const scope: Node = root === document ? document.documentElement : (root as Node);
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue && n.nodeValue.includes('{{')) n.nodeValue = replaceAll(n.nodeValue, cfg);
  }
  const selector = PLACEHOLDER_ATTRS.map((a) => `[${a}*="{{"]`).join(',');
  const els: Element[] = [];
  if (scope instanceof Element && scope.matches(selector)) els.push(scope);
  els.push(...Array.from((scope as ParentNode).querySelectorAll(selector)));
  for (const e of els) {
    for (const a of PLACEHOLDER_ATTRS) {
      const v = e.getAttribute(a);
      if (v && v.includes('{{')) e.setAttribute(a, replaceAll(v, cfg));
    }
  }
}

/** Load the config and apply it to the whole document. Resolves with the config. */
export async function initConfig(): Promise<AppConfig> {
  const sync = getConfigSync();
  if (sync) applyOwnerPlaceholders(sync);
  const cfg = await loadConfig();
  applyOwnerPlaceholders(cfg);
  return cfg;
}
