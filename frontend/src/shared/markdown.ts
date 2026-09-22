/**
 * Rendering message content safely.
 *
 * - {@link renderMarkdown}: Markdown (GFM, single newlines -> <br>) -> HTML,
 *   sanitised with DOMPurify. Only http/https/mailto links survive; every link
 *   opens in a new tab with rel="noopener noreferrer". Images, forms, media,
 *   inline styles, classes and ids are stripped, so content can never spoof a
 *   role bubble or load remote resources.
 * - {@link renderPlainText}: escaped text for visitor messages; blank lines
 *   become paragraphs, single newlines become <br>.
 */
import { Marked } from 'marked';
import DOMPurify from 'dompurify';

const marked = new Marked({ gfm: true, breaks: true, async: false });

const SAFE_PROTOCOL = /^(https?:|mailto:)/i;

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    'img', 'picture', 'source', 'video', 'audio', 'track', 'iframe', 'object', 'embed',
    'form', 'input', 'button', 'textarea', 'select', 'option', 'label', 'fieldset',
    'style', 'link', 'meta', 'base', 'svg', 'math', 'template', 'dialog', 'details', 'summary',
  ],
  FORBID_ATTR: ['style', 'class', 'id', 'name', 'srcset', 'action', 'formaction', 'background'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  ALLOW_DATA_ATTR: false,
};

let hooked = false;
function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName !== 'A') return;
    const a = node as HTMLAnchorElement;
    const href = a.getAttribute('href') ?? '';
    if (!SAFE_PROTOCOL.test(href.trim())) {
      a.removeAttribute('href');
      a.removeAttribute('target');
      a.removeAttribute('rel');
      return;
    }
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
}

/** Sanitise an HTML string with the Avatar policy (see module docs). */
export function sanitizeHtml(html: string): string {
  ensureHooks();
  return DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string;
}

/** Markdown -> sanitised HTML string. */
export function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown ?? '') as string;
  return sanitizeHtml(html);
}

/** Escape text for safe insertion into HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Plain text -> HTML: escaped; blank-line-separated blocks become <p>, single
 * newlines become <br>. Used for visitor messages (never parsed as Markdown).
 */
export function renderPlainText(text: string): string {
  const normalized = (text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '<p></p>';
  return normalized
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Render Markdown into an element (replaces its content). */
export function setMarkdown(target: HTMLElement, markdown: string): void {
  target.innerHTML = renderMarkdown(markdown);
}

/** Render plain text into an element (replaces its content). */
export function setPlainText(target: HTMLElement, text: string): void {
  target.innerHTML = renderPlainText(text);
}
