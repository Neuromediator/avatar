/**
 * The main panel (mockup `.main`): thread head (initials, name, conv id ·
 * started · count, the "Avatar asked for you" flag + Mark resolved, and a back
 * control on mobile), the full thread, and the admin composer with the
 * "posting as you" note. Pure view: the dashboard drives it and does the API calls.
 */
import type { AdminMessage, AppConfig, ConversationSummary } from '../shared/api';
import { createComposer, type ComposerHandle } from '../shared/composer';
import { append, clear, el, icon } from '../shared/dom';
import { plural, shortId } from '../shared/format';
import { renderMarkdown } from '../shared/markdown';
import {
  confirmMessage,
  createHumanAvatar,
  createHumanMessage,
  createNotice,
  createTwinAvatar,
  createVisitorToken,
  fillVisitorToken,
  findMessage,
  insertInOrder,
  insertMessage,
  renderThread,
  updateDaySeparators,
  type MessageRenderOptions,
} from '../shared/messages';
import { composerTarget, displayName, isMobileLayout, isTouchDevice, startedLabel } from './util';

export interface ThreadPanelOptions {
  cfg: AppConfig;
  onSend: (text: string) => Promise<void>;
  onResolve: () => void;
  onBack: () => void;
  onRetry: () => void;
}

/** How close to the bottom (px) still counts as "reading the latest". */
const STICK_THRESHOLD = 96;

export class ThreadPanel {
  readonly element: HTMLElement;
  readonly composer: ComposerHandle;
  private readonly opts: ThreadPanelOptions;
  private readonly head: HTMLDivElement;
  private readonly token: HTMLSpanElement;
  private readonly nameEl: HTMLSpanElement;
  private readonly subEl: HTMLSpanElement;
  private readonly flag: HTMLSpanElement;
  private readonly resolveBtn: HTMLButtonElement;
  private readonly resolveLabel: HTMLSpanElement;
  private readonly scroller: HTMLDivElement;
  readonly inner: HTMLDivElement;
  private readonly dock: HTMLDivElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly placeholderEl: HTMLDivElement;
  private readonly placeholderTitle: HTMLHeadingElement;
  private readonly placeholderText: HTMLParagraphElement;
  private conversationId: string | null = null;
  private name: string | null = null;
  private startedAt: string | null = null;
  private count = 0;
  /** Unsent drafts per conversation (switching threads keeps what you were typing). */
  private readonly drafts = new Map<string, string>();

  constructor(opts: ThreadPanelOptions) {
    this.opts = opts;

    // ---- head ----
    const back = el('button', { type: 'button', class: 'icon-btn back-btn', 'aria-label': 'Back to conversations', title: 'Back to conversations' },
      icon('arrow-left', 'icon--sm'));
    back.addEventListener('click', () => opts.onBack());
    this.token = createVisitorToken(null);
    this.nameEl = el('span', { class: 'name', id: 'threadName' });
    this.subEl = el('span', { class: 'sub' });
    this.flag = el('span', { class: 'attn-flag', role: 'status', hidden: true },
      icon('spark'), el('span', { class: 'attn-text' }, 'Avatar asked for you'));
    this.resolveLabel = el('span', { class: 'resolve-label' }, 'Mark resolved');
    this.resolveBtn = el('button', { type: 'button', class: 'btn btn--secondary btn--sm resolve-btn', hidden: true },
      icon('check', 'icon--sm'), this.resolveLabel);
    this.resolveBtn.addEventListener('click', () => opts.onResolve());
    this.head = el('div', { class: 'thread-head' },
      el('div', { class: 'thread-id' },
        back,
        this.token,
        el('div', { class: 'meta' }, this.nameEl, this.subEl)),
      el('div', { class: 'thread-actions' }, this.flag, this.resolveBtn));

    // ---- thread ----
    this.inner = el('div', { class: 'thread-inner' });
    this.scroller = el('div', {
      class: 'thread scroll',
      id: 'thread',
      role: 'region',
      'aria-labelledby': 'threadName',
      tabindex: '-1',
    }, this.inner);

    // ---- composer ----
    this.textarea = el('textarea', {
      rows: '1',
      placeholder: 'Write a message…',
      'aria-label': 'Message to the visitor',
      enterkeyhint: 'send',
    });
    const send = el('button', { type: 'button', class: 'btn-send', title: 'Send (Enter)', 'aria-label': 'Send message' }, icon('send'));
    const ownerName = opts.cfg.owner_name;
    this.dock = el('div', { class: 'admin-composer-dock' },
      el('div', { class: 'admin-composer-wrap' },
        el('div', { class: 'posting-as' },
          createHumanAvatar(false),
          el('span', { class: 'posting-as-text' },
            'Posting as ', el('strong', null, 'you'),
            '. The visitor sees this with your photo and name, ',
            el('strong', null, `${ownerName} · live`),
            ". The Avatar won't reply to\u00a0it.")),
        el('div', { class: 'composer', id: 'composer' }, this.textarea, send),
        el('div', { class: 'kbd-hints', 'aria-hidden': 'true' },
          el('span', { class: 'h' },
            el('span', { class: 'kbd' }, icon('chev-up', 'kbd-icon')),
            el('span', { class: 'kbd' }, icon('chev-down', 'kbd-icon')),
            ' move between conversations'),
          el('span', { class: 'h' }, el('span', { class: 'kbd' }, 'Enter'), ' send'),
          el('span', { class: 'h' }, el('span', { class: 'kbd' }, 'Shift'), '+', el('span', { class: 'kbd' }, 'Enter'), ' new line'))));

    // ---- placeholder (nothing selected) ----
    this.placeholderTitle = el('h2', { class: 'placeholder-title display' });
    this.placeholderText = el('p', { class: 'placeholder-text' });
    this.setInboxEmpty(false);
    this.placeholderEl = el('div', { class: 'thread-placeholder' },
      el('div', { class: 'placeholder-cast', 'aria-hidden': 'true' },
        createVisitorToken(null),
        createTwinAvatar('avatar--lg'),
        createHumanAvatar(true, 'avatar--lg')),
      el('span', { class: 'eyebrow' }, 'Visitor · Avatar · You'),
      this.placeholderTitle,
      this.placeholderText,
      el('p', { class: 'placeholder-hint' },
        el('span', { class: 'kbd' }, icon('chev-up', 'kbd-icon')),
        el('span', { class: 'kbd' }, icon('chev-down', 'kbd-icon')),
        ' to move between conversations'));

    this.element = el('section', { class: 'main is-empty', 'aria-label': 'Conversation' },
      this.placeholderEl, this.head, this.scroller, this.dock);

    this.composer = createComposer({
      textarea: this.textarea,
      sendButton: send,
      autofocus: false,
      onSend: (text) => opts.onSend(text),
    });
  }

  // ---- accessors -------------------------------------------------------------

  get currentId(): string | null {
    return this.conversationId;
  }

  private get renderOpts(): MessageRenderOptions {
    return { humanLabel: 'You · sent to visitor', ownerFirstName: 'you', visitorName: this.name };
  }

  // ---- states ----------------------------------------------------------------

  private stashDraft(): void {
    const text = this.composer.value;
    if (this.conversationId && text.trim()) this.drafts.set(this.conversationId, text);
  }

  /** Placeholder copy: "pick a conversation", or "waiting for the first visitor" when the inbox is empty. */
  setInboxEmpty(empty: boolean): void {
    this.placeholderEl?.classList.toggle('is-inbox-empty', empty);
    this.placeholderTitle.textContent = empty ? 'Waiting for the first visitor' : 'Pick a conversation';
    this.placeholderText.textContent = empty
      ? 'When someone chats with your Avatar, the thread appears in the inbox. Open it to read along or reply as yourself.'
      : 'Read how your Avatar is handling each visitor, and step in whenever you like. Your reply lands in their chat with your photo and name.';
  }

  /** Nothing selected: the placeholder. */
  showEmpty(): void {
    this.stashDraft();
    this.composer.clear();
    this.conversationId = null;
    this.element.classList.add('is-empty');
    this.element.classList.remove('is-loading');
    this.setAttention(false);
    this.setComposerEnabled(true);
    clear(this.inner);
  }

  /**
   * A row was selected: paint the head from the inbox summary and show a
   * loading state until the thread arrives. Switching clears the previous
   * visitor's messages at once, so the head and the body always belong to the
   * same conversation.
   */
  beginOpen(s: ConversationSummary): void {
    const switching = this.conversationId !== s.conversation_id;
    if (switching) this.stashDraft();
    this.conversationId = s.conversation_id;
    this.startedAt = s.started_at;
    this.count = s.message_count;
    this.setName(s.conversation_name, !switching);
    this.element.classList.remove('is-empty');
    this.setAttention(false);
    this.setComposerEnabled(true);
    if (switching) {
      const draft = this.drafts.get(s.conversation_id) ?? '';
      this.drafts.delete(s.conversation_id);
      if (draft) this.composer.setValue(draft);
      else this.composer.clear();
      this.element.classList.add('is-loading');
      this.inner.setAttribute('aria-busy', 'true');
      clear(this.inner);
      this.inner.appendChild(el('div', { class: 'thread-loading', role: 'status' },
        el('span', { class: 'thinking', 'aria-hidden': 'true' }, el('span', null), el('span', null), el('span', null)),
        ' Loading conversation'));
    }
  }

  /** Render the whole thread (after opening) and scroll to the latest message. */
  render(conversationId: string, name: string | null, messages: AdminMessage[]): void {
    this.conversationId = conversationId;
    this.setName(name);
    clear(this.inner);
    renderThread(this.inner, messages, this.renderOpts);
    this.count = messages.length;
    if (messages.length) this.startedAt = earliest(messages);
    this.paintSub();
    this.element.classList.remove('is-loading');
    this.inner.removeAttribute('aria-busy');
    // Back from a failed open (Try again): the composer returns, focused on desktop.
    if (this.setComposerEnabled(true) && !isTouchDevice() && !isMobileLayout()) this.composer.focus();
    this.scrollToBottom();
  }

  /** Merge a re-fetched thread: append only new rows (animated), keep scroll unless reading the latest. */
  merge(name: string | null, messages: AdminMessage[]): HTMLElement[] {
    const stick = this.isNearBottom();
    if (name) this.setName(name);
    const added: HTMLElement[] = [];
    for (const m of [...messages].sort((a, b) => a.id - b.id)) {
      const node = insertMessage(this.inner, m, { ...this.renderOpts, animate: true });
      if (node) added.push(node);
    }
    this.count = this.inner.querySelectorAll(':scope > .msg[data-id]').length;
    this.paintSub();
    if (stick && added.length) this.scrollToBottom(true);
    return added;
  }

  /** Could not open the thread (404 / error). The composer is disabled: there is no thread to reply to. */
  showError(text: string, retry: boolean): void {
    this.element.classList.remove('is-loading');
    this.inner.removeAttribute('aria-busy');
    this.setComposerEnabled(false);
    clear(this.inner);
    const box = el('div', { class: 'thread-error' }, createNotice(text, { kind: 'error' }));
    if (retry) {
      const btn = el('button', { type: 'button', class: 'btn btn--secondary btn--sm' }, icon('reset', 'icon--sm'), 'Try again');
      btn.addEventListener('click', () => this.opts.onRetry());
      box.appendChild(btn);
    }
    this.inner.appendChild(box);
  }

  /** Enable / disable the composer; returns true when that changed its state. */
  private setComposerEnabled(on: boolean): boolean {
    if (this.textarea.disabled !== on) return false;
    this.composer.setDisabled(!on);
    return true;
  }

  // ---- head ------------------------------------------------------------------

  private setName(name: string | null, updateBubbles = true): void {
    this.name = name?.trim() || null;
    const id = this.conversationId ?? '';
    this.nameEl.textContent = displayName(id, this.name);
    fillVisitorToken(this.token, this.name);
    this.textarea.placeholder = `Write a message to ${composerTarget(this.name)}…`;
    this.textarea.setAttribute('aria-label', `Message to ${displayName(id, this.name)}`);
    if (updateBubbles) {
      this.inner.querySelectorAll<HTMLElement>(':scope > .msg--visitor .avatar-initials').forEach((t) => fillVisitorToken(t, this.name));
    }
    this.paintSub();
  }

  private paintSub(): void {
    if (!this.conversationId) return;
    clear(this.subEl);
    append(this.subEl,
      el('span', { class: 'sub-id' }, shortId(this.conversationId)),
      this.startedAt ? el('span', { class: 'sub-started' }, ` · started ${startedLabel(this.startedAt)}`) : null,
      el('span', { class: 'sub-count' }, ` · ${plural(this.count, 'message')}`),
    );
    this.subEl.title = this.conversationId;
  }

  /** The panel just became visible (mobile detail view): re-measure the composer and jump to the latest. */
  onShown(): void {
    this.composer.autoGrow();
    this.scrollToBottom();
  }

  /** Show / hide the "Avatar asked for you" flag and the Mark resolved button. */
  setAttention(on: boolean): void {
    this.flag.hidden = !on;
    this.resolveBtn.hidden = !on;
    this.head.classList.toggle('has-attention', on);
    if (!on) this.setResolving(false);
  }

  get attentionShown(): boolean {
    return !this.flag.hidden;
  }

  setResolving(busy: boolean): void {
    this.resolveBtn.disabled = busy;
    this.resolveLabel.textContent = busy ? 'Resolving…' : 'Mark resolved';
  }

  // ---- owner's messages ------------------------------------------------------

  /** Optimistic bubble for a message the owner is sending. */
  addPendingHuman(text: string): HTMLDivElement {
    const node = createHumanMessage(
      { id: 0, role: 'human', content: text, created_at: new Date().toISOString(), tool_calls: null },
      { ...this.renderOpts, animate: true },
    );
    node.removeAttribute('data-id');
    node.removeAttribute('data-created');
    node.setAttribute('data-pending', '');
    node.classList.add('is-sending');
    this.inner.querySelectorAll(':scope > .thread-error, :scope > .notice').forEach((n) => n.remove());
    this.inner.appendChild(node);
    this.scrollToBottom(true);
    return node;
  }

  /** The server stored it: give the bubble its row identity and put it in id order (or drop it if a poll already rendered it). */
  confirmHuman(node: HTMLElement, msg: AdminMessage): void {
    if (findMessage(this.inner, msg.id)) {
      node.remove();
    } else if (!node.isConnected) {
      // The thread was re-rendered while this was in flight (sent during loading).
      insertMessage(this.inner, msg, { ...this.renderOpts, animate: false });
    } else {
      confirmMessage(node, msg);
      node.classList.remove('is-sending');
      const bubble = node.querySelector<HTMLElement>('.bubble');
      if (bubble) bubble.innerHTML = renderMarkdown(msg.content);
      insertInOrder(this.inner, node);
    }
    updateDaySeparators(this.inner);
    this.count = this.inner.querySelectorAll(':scope > .msg[data-id]').length;
    this.paintSub();
    this.scrollToBottom(true);
  }

  /** Sending failed: drop the optimistic bubble and explain inline. */
  failHuman(node: HTMLElement, detail: string): void {
    node.remove();
    this.showNotice(detail);
  }

  /** An inline, dismissible error notice at the end of the thread. */
  showNotice(text: string): void {
    this.inner.querySelectorAll(':scope > .notice').forEach((n) => n.remove());
    this.inner.appendChild(createNotice(text, { kind: 'error', dismissible: true }));
    this.scrollToBottom(true);
  }

  /** Highest rendered row id. */
  maxId(): number {
    let max = 0;
    this.inner.querySelectorAll<HTMLElement>(':scope > .msg[data-id]').forEach((n) => {
      const id = Number(n.dataset.id);
      if (Number.isFinite(id) && id > max) max = id;
    });
    return max;
  }

  // ---- scrolling / focus -----------------------------------------------------

  isNearBottom(): boolean {
    const s = this.scroller;
    return s.scrollHeight - s.scrollTop - s.clientHeight <= STICK_THRESHOLD;
  }

  /** Jump (or glide) to the latest message; re-applied next frame for late layout. */
  scrollToBottom(smooth = false): void {
    const s = this.scroller;
    const go = (): void => {
      if (smooth && typeof s.scrollTo === 'function') s.scrollTo({ top: s.scrollHeight, behavior: 'smooth' });
      else s.scrollTop = s.scrollHeight;
    };
    go();
    requestAnimationFrame(() => {
      if (!smooth) s.scrollTop = s.scrollHeight;
      else go();
    });
  }

  focusComposer(): void {
    if (this.conversationId) this.composer.focus();
  }

  /** True when `node` is the thread scroller or inside it (the owner is reading the thread). */
  ownsReadingFocus(node: Node | null): boolean {
    return !!node && this.scroller.contains(node);
  }
}

function earliest(messages: AdminMessage[]): string {
  let best = messages[0]!;
  for (const m of messages) if (m.id < best.id) best = m;
  return best.created_at;
}
