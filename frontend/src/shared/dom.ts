/**
 * Tiny DOM helpers shared by both screens: element builder, sprite icons,
 * the brand mark, and the one-time inline icon-sprite injection.
 */
// The canonical sprite is public/icons.svg (also served at /icons.svg); the
// vite.config.ts plugin exposes its text as this virtual module so it can be
// inlined into the DOM and <use href="#i-..."> resolves in-document.
import spriteSource from 'virtual:icon-sprite';

/** Every symbol id in the icon sprite, minus the `i-` prefix. */
export type IconName =
  | 'send' | 'reset' | 'keep' | 'visitor' | 'avatar' | 'spark' | 'bell' | 'inbox'
  | 'search' | 'sliders' | 'sun' | 'moon' | 'check' | 'check2' | 'dot' | 'lock'
  | 'mail' | 'chev-up' | 'chev-down' | 'chev-right' | 'chev-left' | 'enter' | 'tool'
  | 'copy' | 'close' | 'menu' | 'external' | 'clock' | 'shield' | 'edit'
  | 'arrow-right' | 'arrow-left' | 'eye' | 'live' | 'logout' | 'alert'
  | 'linkedin' | 'github' | 'huggingface';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Attribute values accepted by {@link el}. `false`/`null`/`undefined` skip the attribute; `true` sets it empty. */
export type AttrValue = string | number | boolean | null | undefined;
/** A child accepted by {@link el}. Falsy children are skipped; strings become text nodes. */
export type Child = Node | string | number | null | undefined | false;

/**
 * Create an HTML element.
 *
 *   el('div', { class: 'msg msg--avatar', 'data-id': 12 }, el('span', { class: 'msg-name' }, 'Avatar'))
 *
 * Attribute keys are set verbatim (`class`, `data-*`, `aria-*`, `title`, ...).
 * Strings are always inserted as text (never parsed as HTML).
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, AttrValue> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue;
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(node, ...children);
  return node;
}

/** Append children (skipping falsy ones; strings/numbers as text nodes). */
export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child))
      : child);
  }
}

/** Remove all children of a node. */
export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * A sprite icon: `<svg class="icon {cls}" aria-hidden="true"><use href="#i-{name}"/></svg>`.
 * Sizes via classes from components.css: `icon--sm` (16), `icon--lg` (24), `icon--xl` (32).
 * Requires {@link injectIconSprite} to have run once (both screens' bootstrap does it).
 */
export function icon(name: IconName, cls = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls ? `icon ${cls}` : 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

/** HTML string version of {@link icon}, for static templates. */
export function iconHtml(name: IconName, cls = ''): string {
  return `<svg class="${cls ? `icon ${cls}` : 'icon'}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
}

const SPRITE_ID = 'avatar-icon-sprite';

/**
 * Inject the icon sprite inline at the top of <body> (idempotent), so
 * `<use href="#i-...">` resolves in-document and the sprite's stroke styles
 * apply reliably. The sprite root is visually hidden with a zero-size box
 * rather than `display:none`.
 */
export function injectIconSprite(): void {
  if (document.getElementById(SPRITE_ID)) return;
  const tpl = document.createElement('template');
  tpl.innerHTML = spriteSource.trim();
  const svg = tpl.content.querySelector('svg');
  if (!svg) return;
  svg.id = SPRITE_ID;
  svg.removeAttribute('style');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  document.body.prepend(svg);
}

/**
 * The Avatar brand mark (two discs sharing an axis: one solid blue, one
 * outlined with a yellow node), as used in the mockups' `.brand-mark` tile:
 *
 *   el('span', { class: 'brand-mark', 'aria-hidden': 'true' }, brandMark(22))
 *
 * Colours come from tokens via the `.bm-*` classes in base.css.
 */
export function brandMark(size = 22): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'brand-mark-svg');
  const circle = (cx: number, r: number, cls: string): SVGCircleElement => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', String(cx));
    c.setAttribute('cy', '13');
    c.setAttribute('r', String(r));
    c.setAttribute('class', cls);
    return c;
  };
  svg.append(circle(9.5, 5, 'bm-solid'), circle(15.5, 5, 'bm-ring'), circle(15.5, 1.4, 'bm-node'));
  return svg;
}

/** HTML string version of {@link brandMark}. */
export function brandMarkHtml(size = 22): string {
  return `<svg class="brand-mark-svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">`
    + '<circle class="bm-solid" cx="9.5" cy="13" r="5"></circle>'
    + '<circle class="bm-ring" cx="15.5" cy="13" r="5"></circle>'
    + '<circle class="bm-node" cx="15.5" cy="13" r="1.4"></circle></svg>';
}

/** URL of a file in `public/` (respects Vite's base). e.g. `publicUrl('avatar-human.png')`. */
export function publicUrl(file: string): string {
  return `${import.meta.env.BASE_URL}${file.replace(/^\//, '')}`;
}

/** Public URLs of the three avatar images (copied byte-for-byte from design-system/assets). */
export const AVATAR_IMAGES = {
  human: publicUrl('avatar-human.png'),
  robot: publicUrl('avatar-robot.png'),
  robotRound: publicUrl('avatar-robot-round.png'),
} as const;

/** Query a required element; throws a clear error if the markup is missing it. */
export function $<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}

/** True on touch-first devices (no hover, coarse pointer) - used to avoid popping the phone keyboard. */
export function isTouchDevice(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;
}

/** True when the user prefers reduced motion. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
