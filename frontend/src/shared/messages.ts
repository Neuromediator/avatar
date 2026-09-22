/**
 * DOM builders for the conversation: the three role bubbles (markup and
 * classes exactly as in the design-system mockups), tool-status rows, the
 * Qn instant tag, day separators, ordered/deduped insertion, the streaming
 * avatar bubble, the typing indicator and inline notices.
 *
 * Every rendered message element is `.msg.msg--{role}` with:
 *   data-id="<row id>"        (absent while pending)
 *   data-role="visitor|avatar|human"
 *   data-created="<ISO>"      (used for day separators)
 *   data-pending              (optimistic / streaming elements, until confirmed)
 */
import type { ChatEvent, PublicMessage, Role, ToolCallEntry } from './api';
import { AVATAR_IMAGES, clear, el, icon, type IconName } from './dom';
import { dayKey, formatDaySeparator, formatFullTimestamp, formatMessageTime, initials } from './format';
import { renderMarkdown, renderPlainText } from './markdown';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MessageRenderOptions {
  /**
   * Text of the human bubble's `.human-tag`. Visitor screen:
   * `${owner_name} · live`; admin: "You · sent to visitor". Never hardcode the name.
   */
  humanLabel: string;
  /** Owner's first name, for the push_tool row ("Notified <first name> · push_tool"). */
  ownerFirstName: string;
  /**
   * Name used for the visitor initials token (visitor screen: the name field;
   * admin: the conversation name). Null/empty -> the i-visitor icon.
   */
  visitorName?: string | null;
  /** Play the entrance animation (use for messages that arrive live, not for history). */
  animate?: boolean;
}

/** Stream states, mirrored on the element as data-state. */
export type StreamState = 'thinking' | 'tool-calling' | 'tool-returned' | 'typing' | 'complete' | 'error';

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------

/** Fill a `.avatar-initials` token with initials, or the i-visitor icon when there are none. */
export function fillVisitorToken(token: HTMLElement, name: string | null | undefined): void {
  const text = initials(name);
  clear(token);
  if (text) {
    token.textContent = text;
    token.removeAttribute('data-anonymous');
  } else {
    token.appendChild(icon('visitor', 'icon--sm'));
    token.setAttribute('data-anonymous', '');
  }
}

/** The visitor's blue initials token: `<span class="avatar-initials">JM</span>` (`--sm` for 30px). */
export function createVisitorToken(name: string | null | undefined, size: 'md' | 'sm' = 'md'): HTMLSpanElement {
  const token = el('span', {
    class: size === 'sm' ? 'avatar-initials avatar-initials--sm' : 'avatar-initials',
    'aria-hidden': 'true',
  });
  fillVisitorToken(token, name);
  return token;
}

/** The twin's round avatar: `.avatar.avatar-twin` with avatar-robot-round.png. `extraClass` e.g. "avatar--lg". */
export function createTwinAvatar(extraClass = ''): HTMLDivElement {
  const node = el('div', { class: `avatar avatar-twin${extraClass ? ` ${extraClass}` : ''}`, 'aria-hidden': 'true' });
  node.style.backgroundImage = `url('${AVATAR_IMAGES.robotRound}')`;
  return node;
}

/** The owner's photo: `.avatar.avatar-human` with avatar-human.png, plus the yellow `.spark-badge` by default. */
export function createHumanAvatar(withSpark = true, extraClass = ''): HTMLDivElement {
  const node = el('div', { class: `avatar avatar-human${extraClass ? ` ${extraClass}` : ''}`, 'aria-hidden': 'true' });
  node.style.backgroundImage = `url('${AVATAR_IMAGES.human}')`;
  if (withSpark) node.appendChild(el('span', { class: 'spark-badge' }, icon('spark')));
  return node;
}

/** Update every visitor token in `container` (e.g. after the visitor edits the name field). */
export function setVisitorName(container: ParentNode, name: string | null | undefined): void {
  container.querySelectorAll<HTMLElement>('.msg--visitor .avatar-initials').forEach((t) => fillVisitorToken(t, name));
}

// ---------------------------------------------------------------------------
// Tool status + instant tag
// ---------------------------------------------------------------------------

/** Pull the FAQ number out of a faq_tool arguments JSON string (null if absent). */
export function faqNumberFromArgs(args: string | null | undefined): number | null {
  if (!args) return null;
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      for (const key of ['question_number', 'number', 'faq', 'n', 'question']) {
        const v = obj[key];
        const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v.replace(/^q/i, ''), 10) : NaN;
        if (Number.isInteger(n) && n > 0) return n;
      }
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * Whether a stored push_tool output reports a delivered notification. Mirrors
 * the backend's `push_delivered()`: "not configured" or any "fail" means the
 * push did not go out (the conversation is still flagged in the dashboard).
 */
export function pushDelivered(output: string | null | undefined): boolean {
  const low = (output ?? '').toLowerCase();
  return !(low.includes('fail') || low.includes('not configured'));
}

export interface ToolDescription {
  /** Icon for the done state. */
  icon: IconName;
  /** Live text, without the trailing ellipsis (rendered via `.dots`). */
  liveText: string;
  /** Done text, e.g. "Looked up the FAQ · Q12". */
  doneText: string;
  /** Text when the reply failed before the tool returned, e.g. "faq_tool · stopped". */
  stoppedText: string;
}

/**
 * How a tool call is labelled (faq_tool / push_tool / anything else).
 * `delivered` (push_tool only): false -> "Flagged for <first>" instead of
 * claiming a notification went out; undefined/true -> "Notified <first>".
 */
export function describeTool(
  name: string,
  args: string | null | undefined,
  ownerFirstName: string,
  delivered?: boolean,
): ToolDescription {
  const liveText = `Calling ${name}`;
  const stoppedText = `${name} · stopped`;
  if (name === 'faq_tool') {
    const n = faqNumberFromArgs(args);
    return { icon: 'check', liveText, stoppedText, doneText: `Looked up the FAQ · ${n ? `Q${n}` : 'faq_tool'}` };
  }
  if (name === 'push_tool') {
    const verb = delivered === false ? 'Flagged for' : 'Notified';
    return { icon: 'mail', liveText, stoppedText, doneText: `${verb} ${ownerFirstName} · push_tool` };
  }
  return { icon: 'tool', liveText, stoppedText, doneText: `${name} · returned` };
}

/** Tool row states: running, returned, or cut off by a failed reply. */
export type ToolRowState = 'live' | 'done' | 'stopped';

/**
 * A `.tool-status` row. Live: i-tool + "Calling faq_tool…" (the ellipsis is
 * the `.dots` span). Done (`.is-done`): the tool's icon + its done text.
 * Stopped (`.is-stopped`): i-close + "faq_tool · stopped" (the reply failed first).
 */
export function createToolStatus(
  name: string,
  args: string | null | undefined,
  state: ToolRowState,
  ownerFirstName: string,
  callId?: string,
  delivered?: boolean,
): HTMLDivElement {
  const row = el('div', { class: 'tool-status', 'data-tool': name, 'data-call-id': callId ?? null });
  paintToolStatus(row, name, args, state, ownerFirstName, delivered);
  return row;
}

function paintToolStatus(
  row: HTMLElement,
  name: string,
  args: string | null | undefined,
  state: ToolRowState,
  ownerFirstName: string,
  delivered?: boolean,
): void {
  const d = describeTool(name, args, ownerFirstName, delivered);
  clear(row);
  row.classList.toggle('is-done', state === 'done');
  row.classList.toggle('is-stopped', state === 'stopped');
  row.dataset.state = state;
  if (state === 'done') {
    row.append(icon(d.icon), ` ${d.doneText}`);
  } else if (state === 'stopped') {
    row.append(icon('close'), ` ${d.stoppedText}`);
  } else {
    row.append(icon('tool'), ` ${d.liveText}`, el('span', { class: 'dots', 'aria-hidden': 'true' }));
  }
}

/**
 * Whether an instant (Qn shortcut) reply is that FAQ entry. A hit restates the
 * question first, "**Q2:** ..." (SPEC); a miss ("There is no **Q99** ...") does not.
 */
export function instantHit(content: string, faq: number): boolean {
  return content.trimStart().startsWith(`**Q${faq}:**`);
}

/** The Qn tag: `<span class="instant-tag">instant · Q2</span>`; just "instant" when there is no such FAQ. */
export function createInstantTag(faq: number, hit = true): HTMLSpanElement {
  return el('span', { class: 'instant-tag', title: 'Instant FAQ answer - no model call' }, hit ? `instant · Q${faq}` : 'instant');
}

/** The FAQ number of an instant (Qn shortcut) reply, from its tool_calls; null otherwise. */
export function instantFaqOf(toolCalls: ToolCallEntry[] | null | undefined): number | null {
  const hit = toolCalls?.find((t) => t.type === 'instant');
  return hit && hit.type === 'instant' ? hit.faq : null;
}

// ---------------------------------------------------------------------------
// Message elements
// ---------------------------------------------------------------------------

function timeEl(iso: string | null): HTMLSpanElement {
  const span = el('span', { class: 'msg-time' });
  setTime(span, iso);
  return span;
}

function setTime(span: HTMLElement, iso: string | null): void {
  const when = iso ?? new Date().toISOString();
  span.textContent = formatMessageTime(when);
  span.title = formatFullTimestamp(when);
}

function baseMessage(role: Role, msg: Pick<PublicMessage, 'id' | 'created_at'> | null, animate?: boolean): HTMLDivElement {
  const node = el('div', {
    class: `msg msg--${role}${animate ? ' is-entering' : ''}`,
    'data-role': role,
    'data-id': msg ? msg.id : null,
    'data-created': msg ? msg.created_at : null,
    'data-pending': msg ? null : true,
  });
  if (animate) {
    // Drop the class once the longest entrance animation ends (the human
    // bubble's glow reveal outlasts the slide-in).
    const last = role === 'human' ? 'human-reveal' : 'msg-in';
    const onEnd = (e: AnimationEvent): void => {
      if (e.animationName !== last) return;
      node.classList.remove('is-entering');
      node.removeEventListener('animationend', onEnd);
    };
    node.addEventListener('animationend', onEnd);
  }
  return node;
}

/**
 * Visitor bubble (right-aligned):
 * `.msg.msg--visitor > .avatar-initials + .msg-body > (.msg-meta > .msg-time) + .bubble`.
 * Content is plain text (escaped, line breaks kept).
 */
export function createVisitorMessage(msg: PublicMessage, opts: MessageRenderOptions): HTMLDivElement {
  const node = baseMessage('visitor', msg, opts.animate);
  const bubble = el('div', { class: 'bubble' });
  bubble.innerHTML = renderPlainText(msg.content);
  node.append(
    createVisitorToken(opts.visitorName),
    el('div', { class: 'msg-body' }, el('div', { class: 'msg-meta' }, timeEl(msg.created_at)), bubble),
  );
  return node;
}

/**
 * Optimistic visitor bubble shown immediately on send (data-pending, no id).
 * Confirm it with {@link confirmMessage} when the SSE `start` event arrives.
 */
export function createPendingVisitorMessage(text: string, opts: MessageRenderOptions): HTMLDivElement {
  const node = createVisitorMessage({ id: 0, role: 'visitor', content: text, created_at: new Date().toISOString(), tool_calls: null }, opts);
  node.removeAttribute('data-id');
  node.removeAttribute('data-created');
  node.setAttribute('data-pending', '');
  return node;
}

/** Give a pending element its stored row identity (id, created_at, time label; content for visitor rows). */
export function confirmMessage(node: HTMLElement, msg: PublicMessage): void {
  node.dataset.id = String(msg.id);
  node.dataset.created = msg.created_at;
  node.removeAttribute('data-pending');
  const t = node.querySelector<HTMLElement>('.msg-time');
  if (t) setTime(t, msg.created_at);
  if (msg.role === 'visitor') {
    const bubble = node.querySelector<HTMLElement>('.bubble');
    if (bubble) bubble.innerHTML = renderPlainText(msg.content);
  }
}

function avatarMeta(instant: number | null, iso: string | null, content = ''): HTMLDivElement {
  return el('div', { class: 'msg-meta' },
    el('span', { class: 'msg-name' }, 'Avatar'),
    instant !== null ? createInstantTag(instant, instantHit(content, instant)) : null,
    timeEl(iso));
}

function toolRowsFor(toolCalls: ToolCallEntry[] | null | undefined, ownerFirstName: string): HTMLDivElement[] {
  return (toolCalls ?? [])
    .filter((t): t is Extract<ToolCallEntry, { type: 'function' }> => t.type === 'function')
    .map((t) => createToolStatus(t.name, t.arguments, 'done', ownerFirstName, undefined,
      t.name === 'push_tool' ? pushDelivered(t.output) : undefined));
}

/**
 * Avatar (twin) bubble (left): twin avatar, name "Avatar", optional
 * `.instant-tag`, done `.tool-status` rows above the bubble, Markdown content.
 */
export function createAvatarMessage(msg: PublicMessage, opts: MessageRenderOptions): HTMLDivElement {
  const node = baseMessage('avatar', msg, opts.animate);
  const bubble = el('div', { class: 'bubble' });
  bubble.innerHTML = renderMarkdown(msg.content);
  node.append(
    createTwinAvatar(),
    el('div', { class: 'msg-body' },
      avatarMeta(instantFaqOf(msg.tool_calls), msg.created_at, msg.content),
      ...toolRowsFor(msg.tool_calls, opts.ownerFirstName),
      bubble),
  );
  return node;
}

/**
 * Human bubble (left): owner photo with yellow ring + spark badge, a
 * `.human-tag` (i-live + `opts.humanLabel`), tinted glowing bubble, Markdown content.
 */
export function createHumanMessage(msg: PublicMessage, opts: MessageRenderOptions): HTMLDivElement {
  const node = baseMessage('human', msg, opts.animate);
  const bubble = el('div', { class: 'bubble' });
  bubble.innerHTML = renderMarkdown(msg.content);
  node.append(
    createHumanAvatar(true),
    el('div', { class: 'msg-body' },
      el('div', { class: 'msg-meta' },
        el('span', { class: 'human-tag' }, icon('live'), ` ${opts.humanLabel}`),
        timeEl(msg.created_at)),
      bubble),
  );
  return node;
}

/** Build the right bubble for any message row. */
export function createMessageElement(msg: PublicMessage, opts: MessageRenderOptions): HTMLDivElement {
  switch (msg.role) {
    case 'visitor': return createVisitorMessage(msg, opts);
    case 'human': return createHumanMessage(msg, opts);
    default: return createAvatarMessage(msg, opts);
  }
}

// ---------------------------------------------------------------------------
// Ordering, dedupe, day separators
// ---------------------------------------------------------------------------

function idOf(node: Element): number | null {
  const raw = (node as HTMLElement).dataset?.id;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** The rendered element for a row id, if present (direct children of `container`). */
export function findMessage(container: ParentNode, id: number): HTMLElement | null {
  return container.querySelector<HTMLElement>(`:scope > [data-id="${id}"]`);
}

/** Highest rendered row id in `container` (0 when none). */
export function maxMessageId(container: ParentNode): number {
  let max = 0;
  container.querySelectorAll<HTMLElement>(':scope > [data-id]').forEach((n) => {
    const id = idOf(n);
    if (id !== null && id > max) max = id;
  });
  return max;
}

/**
 * Insert a message element (with data-id) in id order among `container`'s
 * direct children: before the first child with a larger data-id; otherwise
 * before the first `[data-pending]` child (optimistic bubble, streaming bubble,
 * typing indicator); otherwise at the end. Non-message children (intro,
 * notices, separators) are left in place.
 */
export function insertInOrder(container: HTMLElement, node: HTMLElement): void {
  const id = idOf(node);
  const children = Array.from(container.children).filter((c) => c !== node);
  if (id !== null) {
    const next = children.find((c) => {
      const cid = idOf(c);
      return cid !== null && cid > id;
    });
    if (next) {
      container.insertBefore(node, next);
      return;
    }
  }
  const pending = children.find((c) => c.hasAttribute('data-pending'));
  if (pending) container.insertBefore(node, pending);
  else container.appendChild(node);
}

/** A day separator: `<div class="day-sep"><span>Today · 2:41 PM</span></div>`. */
export function createDaySeparator(iso: string, now: Date = new Date()): HTMLDivElement {
  return el('div', { class: 'day-sep', 'data-day-sep': dayKey(iso), role: 'separator' },
    el('span', null, formatDaySeparator(iso, now)));
}

/**
 * Re-derive day separators in `container`: removes the old ones and inserts one
 * before the first message (by data-created) of each calendar day. Call after
 * any insertion ({@link insertMessage} and {@link renderThread} do).
 */
export function updateDaySeparators(container: HTMLElement, now: Date = new Date()): void {
  container.querySelectorAll(':scope > .day-sep[data-day-sep]').forEach((n) => n.remove());
  let lastKey: string | null = null;
  for (const child of Array.from(container.children) as HTMLElement[]) {
    const created = child.dataset?.created;
    if (!created || !child.classList.contains('msg')) continue;
    const key = dayKey(created);
    if (key !== lastKey) {
      container.insertBefore(createDaySeparator(created, now), child);
      lastKey = key;
    }
  }
}

/**
 * Deduped, ordered insert of one message row: returns the new element, or
 * null when a bubble with that id is already rendered. Updates day separators.
 */
export function insertMessage(container: HTMLElement, msg: PublicMessage, opts: MessageRenderOptions): HTMLElement | null {
  if (findMessage(container, msg.id)) return null;
  const node = createMessageElement(msg, opts);
  insertInOrder(container, node);
  updateDaySeparators(container);
  return node;
}

/**
 * Render a whole thread into `container`: removes previously rendered
 * messages / separators / pending nodes (other children, e.g. an intro block,
 * are kept), then inserts all rows in order with day separators.
 */
export function renderThread(container: HTMLElement, messages: PublicMessage[], opts: MessageRenderOptions): void {
  container.querySelectorAll(':scope > .msg, :scope > .day-sep, :scope > [data-pending]').forEach((n) => n.remove());
  const sorted = [...messages].sort((a, b) => a.id - b.id);
  const frag = document.createDocumentFragment();
  for (const m of sorted) frag.appendChild(createMessageElement(m, { ...opts, animate: false }));
  container.appendChild(frag);
  updateDaySeparators(container);
}

// ---------------------------------------------------------------------------
// Streaming avatar bubble
// ---------------------------------------------------------------------------

export interface StreamingOptions extends MessageRenderOptions {
  /** Called after every visible change (tool row, rendered text, finalize) - e.g. to keep the thread scrolled. */
  onUpdate?: () => void;
}

function thinkingDots(): HTMLSpanElement {
  return el('span', { class: 'thinking', 'aria-label': 'Avatar is thinking' },
    el('span', null), el('span', null), el('span', null));
}

/**
 * A live avatar reply driven by the /api/chat SSE events.
 *
 *   const reply = new StreamingAvatarMessage({ humanLabel, ownerFirstName, onUpdate: scrollToEnd });
 *   thread.appendChild(reply.element);            // data-pending, state "thinking"
 *   for await (const ev of streamChat(req)) {
 *     if (ev.type === 'start') confirmMessage(pendingVisitorEl, ev.visitor_message);
 *     else reply.handle(ev);                      // instant / tool_* / delta / done / error
 *   }
 *   // after `done`: reply.element is a normal .msg--avatar with data-id (dedupes with polls)
 *
 * States (data-state): thinking -> tool-calling -> tool-returned -> typing -> complete | error.
 * Delta text is re-rendered as Markdown at most once per animation frame; the
 * `done` message's content is authoritative and replaces the streamed text.
 */
export class StreamingAvatarMessage {
  readonly element: HTMLDivElement;
  private readonly opts: StreamingOptions;
  private readonly body: HTMLDivElement;
  private readonly meta: HTMLDivElement;
  private readonly bubble: HTMLDivElement;
  private readonly tools = new Map<string, { row: HTMLDivElement; name: string; args: string; delivered?: boolean }>();
  private buffer = '';
  private frame = 0;
  private _state: StreamState = 'thinking';
  /** FAQ number of an instant (Qn shortcut) reply, once the `instant` event arrived. */
  private instantFaq: number | null = null;

  constructor(opts: StreamingOptions) {
    this.opts = opts;
    this.element = baseMessage('avatar', null, opts.animate ?? true);
    this.meta = avatarMeta(null, null);
    this.bubble = el('div', { class: 'bubble is-thinking' }, thinkingDots());
    this.body = el('div', { class: 'msg-body' }, this.meta, this.bubble);
    this.element.append(createTwinAvatar(), this.body);
    this.element.setAttribute('aria-busy', 'true');
    this.setState('thinking');
  }

  /** Current stream state. */
  get state(): StreamState {
    return this._state;
  }

  /** The text streamed so far. */
  get text(): string {
    return this.buffer;
  }

  private setState(state: StreamState): void {
    this._state = state;
    this.element.dataset.state = state;
  }

  private changed(): void {
    this.opts.onUpdate?.();
  }

  /** Dispatch one SSE event (`start` is ignored - it concerns the visitor bubble). */
  handle(ev: ChatEvent): void {
    switch (ev.type) {
      case 'instant': this.setInstant(ev.faq); break;
      case 'tool_called': this.toolCalled(ev.call_id, ev.name, ev.arguments); break;
      case 'tool_output': this.toolOutput(ev.call_id, ev.name, ev.ok); break;
      case 'delta': this.appendDelta(ev.text); break;
      case 'done': this.finalize(ev.message); break;
      case 'error': this.fail(ev.detail); break;
      default: break;
    }
  }

  /** Show the instant tag (Qn shortcut): `instant · Qn` once the text shows it is that FAQ, else `instant`. */
  setInstant(faq: number): void {
    this.instantFaq = faq;
    this.paintInstant();
    this.changed();
  }

  private paintInstant(): void {
    if (this.instantFaq === null) return;
    this.meta.querySelector('.instant-tag')?.remove();
    this.meta.insertBefore(createInstantTag(this.instantFaq, instantHit(this.buffer, this.instantFaq)), this.meta.querySelector('.msg-time'));
  }

  /** A tool started: add a live "Calling {name}…" row above the bubble. */
  toolCalled(callId: string, name: string, args: string): void {
    const row = createToolStatus(name, args, 'live', this.opts.ownerFirstName, callId);
    this.tools.set(callId, { row, name, args });
    this.body.insertBefore(row, this.bubble);
    if (!this.buffer) this.setState('tool-calling');
    this.changed();
  }

  /** A tool returned: switch its row to the done state (`ok`: push_tool delivery, when known). */
  toolOutput(callId: string, name: string, ok?: boolean): void {
    let entry = this.tools.get(callId);
    if (!entry) {
      // Output without a matching call (shouldn't happen): show it as done anyway.
      this.toolCalled(callId, name, '');
      entry = this.tools.get(callId)!;
    }
    entry.delivered = ok;
    paintToolStatus(entry.row, entry.name, entry.args, 'done', this.opts.ownerFirstName, ok);
    if (!this.buffer) {
      const anyLive = Array.from(this.tools.values()).some((t) => t.row.dataset.state === 'live');
      this.setState(anyLive ? 'tool-calling' : 'tool-returned');
    }
    this.changed();
  }

  /** Append streamed text; Markdown re-render is throttled to one per animation frame. */
  appendDelta(text: string): void {
    if (!text) return;
    this.buffer += text;
    if (this.instantFaq !== null) this.paintInstant();
    if (this._state !== 'typing') {
      this.setState('typing');
      this.bubble.classList.remove('is-thinking');
      this.bubble.classList.add('is-streaming');
    }
    if (!this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.renderBuffer();
      });
    }
  }

  private renderBuffer(): void {
    this.bubble.innerHTML = renderMarkdown(this.buffer);
    this.changed();
  }

  private cancelFrame(): void {
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }

  /**
   * `done`: become the stored avatar row - data-id / data-created set,
   * data-pending removed, authoritative content and tool rows rendered.
   * Returns the element (now a regular `.msg--avatar`).
   */
  finalize(message: PublicMessage): HTMLDivElement {
    this.cancelFrame();
    this.buffer = message.content;
    confirmMessage(this.element, message);
    this.element.removeAttribute('aria-busy');
    const faq = instantFaqOf(message.tool_calls);
    if (faq !== null) this.setInstant(faq);
    const authoritative = toolRowsFor(message.tool_calls, this.opts.ownerFirstName);
    if (authoritative.length || message.tool_calls) {
      this.body.querySelectorAll(':scope > .tool-status').forEach((n) => n.remove());
      for (const row of authoritative) this.body.insertBefore(row, this.bubble);
    } else {
      this.tools.forEach((t) => paintToolStatus(t.row, t.name, t.args, 'done', this.opts.ownerFirstName, t.delivered));
    }
    this.bubble.classList.remove('is-thinking', 'is-streaming');
    this.bubble.innerHTML = renderMarkdown(message.content);
    this.setState('complete');
    const parent = this.element.parentElement;
    if (parent) updateDaySeparators(parent);
    this.changed();
    return this.element;
  }

  /**
   * `error` (or a failed/interrupted stream): keep any streamed text, mark
   * live tool rows as stopped, and append an inline error notice. The element
   * stays data-pending (no row id) - remove it with {@link remove} if the
   * stored reply later arrives via polling.
   */
  fail(detail: string): void {
    this.cancelFrame();
    this.element.removeAttribute('aria-busy');
    if (this.buffer) {
      this.bubble.classList.remove('is-thinking', 'is-streaming');
      this.bubble.innerHTML = renderMarkdown(this.buffer);
    } else {
      this.bubble.remove();
    }
    this.tools.forEach((t) => {
      if (t.row.dataset.state === 'live') paintToolStatus(t.row, t.name, t.args, 'stopped', this.opts.ownerFirstName);
    });
    this.body.querySelector(':scope > .notice')?.remove();
    this.body.appendChild(createNotice(detail, { kind: 'error' }));
    this.setState('error');
    this.changed();
  }

  /** Remove the element from the DOM (e.g. superseded by the stored row). */
  remove(): void {
    this.cancelFrame();
    this.element.remove();
  }
}

// ---------------------------------------------------------------------------
// Typing indicator + notices
// ---------------------------------------------------------------------------

/** The mockup's typing line: three cyan dots + "Avatar is typing" (data-pending). */
export function createTypingIndicator(label = 'Avatar is typing'): HTMLDivElement {
  return el('div', { class: 'typing', 'data-pending': true, role: 'status' },
    el('span', { class: 'dots', 'aria-hidden': 'true' }, el('span', null), el('span', null), el('span', null)),
    ` ${label}`);
}

export type NoticeKind = 'error' | 'info' | 'rate-limit';

export interface NoticeOptions {
  kind?: NoticeKind;
  /** Override the icon (defaults: error -> i-alert, info -> i-alert, rate-limit -> i-clock). i-live stays the human's. */
  icon?: IconName;
  /** Adds a close button that removes the notice. */
  dismissible?: boolean;
}

/**
 * An inline system notice (NOT a role bubble), for errors, rate limiting and
 * connection hints: `<div class="notice notice--error" role="alert">…</div>`.
 */
export function createNotice(text: string, options: NoticeOptions = {}): HTMLDivElement {
  const kind = options.kind ?? 'info';
  const iconName: IconName = options.icon ?? (kind === 'rate-limit' ? 'clock' : 'alert');
  const node = el('div', { class: `notice notice--${kind}`, role: kind === 'info' ? 'status' : 'alert' },
    icon(iconName, 'icon--sm'),
    el('span', { class: 'notice-text' }, text));
  if (options.dismissible) {
    const close = el('button', { type: 'button', class: 'notice-close', 'aria-label': 'Dismiss' }, icon('close', 'icon--sm'));
    close.addEventListener('click', () => node.remove());
    node.appendChild(close);
  }
  return node;
}
