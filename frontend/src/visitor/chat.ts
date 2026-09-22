/**
 * The visitor chat controller: session (conversation id / Keep chat / name),
 * history restore, sending + SSE streaming, polling for the owner's async
 * messages, Reset, the `?q=N` deep link, notices and focus management.
 *
 * Behaviour follows SPEC.md "The Interactive Chat Experience" and the shared
 * architecture contract; markup/classes come from the design-system mockup.
 */
import {
  ApiError,
  RATE_LIMIT_MESSAGE,
  RateLimitedError,
  StreamInterruptedError,
  getConversation,
  isAbortError,
  streamChat,
  type AppConfig,
  type PublicMessage,
} from '../shared/api';
import { createComposer, type ComposerHandle } from '../shared/composer';
import { isTouchDevice } from '../shared/dom';
import { truncate } from '../shared/format';
import {
  StreamingAvatarMessage,
  confirmMessage,
  createNotice,
  createPendingVisitorMessage,
  insertMessage,
  setVisitorName,
  updateDaySeparators,
  type MessageRenderOptions,
  type NoticeKind,
} from '../shared/messages';
import { bindThemeToggle } from '../shared/theme';
import { takeDeepLinkQuestion } from './deeplink';
import { Poller } from './poller';
import { ThreadScroller } from './scroller';
import { VisitorSession, normalizeName } from './session';

export interface VisitorElements {
  convo: HTMLElement;
  thread: HTMLElement;
  intro: HTMLElement;
  textarea: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  nameInput: HTMLInputElement;
  keepInput: HTMLInputElement;
  resetButton: HTMLButtonElement;
  themeButton: HTMLButtonElement;
  jumpButton: HTMLButtonElement;
  liveRegion: HTMLElement;
  chips: HTMLButtonElement[];
}

/** Notice tags: at most one notice per tag is shown. */
type NoticeTag = 'send' | 'history' | 'stream';

const INTERRUPTED_TEXT = 'The connection dropped before the reply finished. It will appear here in a moment.';
const HISTORY_TEXT = "Couldn't load your earlier messages. They will appear once the connection recovers.";
const NARROW_QUERY = '(max-width: 640px)';

/** Rough Markdown -> plain text, for screen-reader announcements. */
function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class VisitorChat {
  private readonly cfg: AppConfig;
  private readonly els: VisitorElements;
  private readonly session = new VisitorSession();
  private readonly composer: ComposerHandle;
  private readonly scroller: ThreadScroller;
  private readonly poller: Poller;

  /** Bumped on Reset: async work from an older conversation is ignored. */
  private generation = 0;
  /** Highest row id seen in history / poll responses (never from SSE ids). */
  private cursor = 0;
  /** The conversation has stored rows (or a send reached the server): polling applies. */
  private started = false;
  /** The initial history fetch failed: the next full poll stands in for it. */
  private historyPending = false;
  /** A send / stream is in flight (polling paused, send blocked). */
  private inFlight = false;
  private abort: AbortController | null = null;
  /** Reply bubble of a dropped stream, replaced when the stored reply arrives by poll. */
  private orphanReply: StreamingAvatarMessage | null = null;
  /** Unconfirmed visitor bubble of a dropped stream (no `start` received). */
  private orphanVisitor: HTMLElement | null = null;
  /** Row id watermark for resolving the orphans above. */
  private orphanSince = 0;
  /** Unseen owner messages while the tab is hidden (shown in the tab title). */
  private unseen = 0;
  private readonly baseTitle = document.title;

  constructor(cfg: AppConfig, els: VisitorElements) {
    this.cfg = cfg;
    this.els = els;
    this.composer = createComposer({
      textarea: els.textarea,
      sendButton: els.sendButton,
      onSend: (text) => this.send(text),
    });
    this.scroller = new ThreadScroller(els.convo, els.jumpButton, () => this.refocus());
    this.poller = new Poller({
      poll: () => this.poll(),
      canPoll: () => !this.inFlight && this.started,
    });
    this.bindControls();
  }

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  /** Restore a kept chat (if any), then handle a `?q=N` deep link. */
  async start(): Promise<void> {
    if (this.session.restored) await this.loadHistory();
    this.els.thread.dataset.state = 'ready';
    this.composer.focus();
    const question = takeDeepLinkQuestion();
    if (question) void this.send(question);
  }

  private bindControls(): void {
    const { nameInput, keepInput, resetButton, themeButton, chips, textarea } = this.els;

    // Name / initials (persisted; updates the visitor tokens already shown).
    nameInput.value = VisitorSession.loadName();
    nameInput.addEventListener('input', () => {
      VisitorSession.saveName(nameInput.value);
      setVisitorName(this.els.thread, normalizeName(nameInput.value));
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        this.composer.focus();
      }
    });

    // Keep chat (default on). The conversation on screen stays either way.
    keepInput.checked = this.session.keep;
    keepInput.addEventListener('change', () => {
      this.session.setKeep(keepInput.checked);
      this.announce(keepInput.checked
        ? 'Keep chat is on. This conversation will be here when you come back.'
        : 'Keep chat is off. This conversation will not be kept after you leave.');
      this.refocus();
    });

    resetButton.addEventListener('click', () => this.reset());

    bindThemeToggle(themeButton);
    themeButton.addEventListener('click', () => this.refocus());

    // Example prompts submit immediately.
    for (const chip of chips) {
      chip.addEventListener('click', () => {
        const text = (chip.textContent ?? '').trim();
        if (text) void this.send(text);
        else this.composer.focus();
      });
    }

    // Shorter placeholder on phones (the full one wraps).
    const narrow = typeof matchMedia === 'function' ? matchMedia(NARROW_QUERY) : null;
    const first = this.cfg.owner_first_name;
    const setPlaceholder = (): void => {
      textarea.placeholder = narrow?.matches
        ? `Message ${first}’s twin…`
        : `Message ${first}’s twin…  (type “Q2” for an instant answer)`;
      // Chrome sizes an empty textarea by its placeholder: re-measure.
      this.composer.autoGrow();
    };
    setPlaceholder();
    narrow?.addEventListener('change', setPlaceholder);

    // Catch up as soon as the tab is visible again (background timers are throttled).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      this.clearUnseen();
      if (this.started) this.poller.pollSoon(0);
    });
    window.addEventListener('focus', () => this.clearUnseen());
  }

  // -------------------------------------------------------------------------
  // Rendering helpers
  // -------------------------------------------------------------------------

  private visitorName(): string | null {
    return normalizeName(this.els.nameInput.value);
  }

  private renderOpts(animate: boolean): MessageRenderOptions {
    return {
      humanLabel: `${this.cfg.owner_name} · live`,
      ownerFirstName: this.cfg.owner_first_name,
      visitorName: this.visitorName(),
      animate,
    };
  }

  /** Show the intro only while the thread has no messages. */
  private syncIntro(): void {
    const hasMessages = !!this.els.thread.querySelector(':scope > .msg');
    this.els.intro.hidden = hasMessages;
    this.els.thread.classList.toggle('has-messages', hasMessages);
    this.scroller.setIntro(!hasMessages);
  }

  /**
   * Re-focus the composer after a non-send control (Theme, Keep chat, Reset,
   * the Latest pill). Skipped on touch devices so the phone keyboard doesn't
   * pop up over what the visitor just changed. Page load and sending always
   * focus (SPEC), via `composer.focus()` directly.
   */
  private refocus(): void {
    if (!isTouchDevice()) this.composer.focus();
  }

  /** Politely announce text to screen readers. */
  private announce(text: string): void {
    const region = this.els.liveRegion;
    region.textContent = '';
    requestAnimationFrame(() => {
      region.textContent = text;
    });
  }

  private showNotice(text: string, kind: NoticeKind, tag: NoticeTag): HTMLElement {
    this.clearNotice(tag);
    const node = createNotice(text, { kind, dismissible: true });
    node.dataset.notice = tag;
    this.els.thread.appendChild(node);
    this.scroller.toBottom();
    return node;
  }

  private clearNotice(tag: NoticeTag): void {
    this.els.thread.querySelectorAll(`:scope > .notice[data-notice="${tag}"]`).forEach((n) => n.remove());
  }

  /** A kept chat's stored name fills an empty name field. */
  private applyServerName(name: string | null): void {
    if (!name || this.els.nameInput.value.trim()) return;
    this.els.nameInput.value = name;
    VisitorSession.saveName(name);
    setVisitorName(this.els.thread, normalizeName(name));
  }

  private markStarted(): void {
    this.started = true;
    this.poller.start();
  }

  private clearUnseen(): void {
    if (!this.unseen) return;
    this.unseen = 0;
    document.title = this.baseTitle;
  }

  private noteUnseen(): void {
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    this.unseen += 1;
    document.title = `(${this.unseen}) ${this.baseTitle}`;
  }

  /**
   * Insert rows from a history or poll response: deduped by id, in id order
   * (so an owner message that arrived during a stream lands before the reply
   * stored after it). Advances the poll cursor. Returns the number of new rows.
   */
  private ingest(messages: PublicMessage[], live: boolean): number {
    if (!messages.length) return 0;
    const sorted = [...messages].sort((a, b) => a.id - b.id);

    // A dropped stream's placeholders give way to the stored rows.
    if (this.orphanReply && sorted.some((m) => m.role === 'avatar' && m.id > this.orphanSince)) {
      this.orphanReply.remove();
      this.orphanReply = null;
      this.clearNotice('stream');
    }
    if (this.orphanVisitor && sorted.some((m) => m.role === 'visitor' && m.id > this.orphanSince)) {
      this.orphanVisitor.remove();
      this.orphanVisitor = null;
    }

    let fresh = 0;
    const opts = this.renderOpts(live);
    for (const msg of sorted) {
      const node = insertMessage(this.els.thread, msg, opts);
      if (msg.id > this.cursor) this.cursor = msg.id;
      if (!node) continue;
      fresh += 1;
      if (live && msg.role === 'human') {
        this.announce(`${this.cfg.owner_name} joined the conversation: ${truncate(plainText(msg.content), 240)}`);
        this.noteUnseen();
      } else if (live && msg.role === 'avatar') {
        this.announce(`Avatar: ${truncate(plainText(msg.content), 240)}`);
      }
    }
    if (fresh) {
      this.syncIntro();
      if (live) this.scroller.contentChanged(true);
    }
    return fresh;
  }

  // -------------------------------------------------------------------------
  // History + polling
  // -------------------------------------------------------------------------

  private async loadHistory(): Promise<void> {
    const gen = this.generation;
    const id = this.session.id;
    try {
      const res = await getConversation(id);
      if (gen !== this.generation) return;
      this.applyServerName(res.conversation_name);
      this.ingest(res.messages, false);
      // An empty kept chat keeps the intro, read from the top.
      if (!res.messages.length) return;
      this.markStarted();
      this.scroller.toBottom();
      // Web fonts can change line wrapping after the first layout.
      void document.fonts?.ready.then(() => {
        if (gen === this.generation && this.scroller.isAtBottom) this.scroller.toBottom();
      });
    } catch {
      if (gen !== this.generation) return;
      // Retry through polling: with the cursor at 0 a poll fetches the whole thread.
      this.historyPending = true;
      this.showNotice(HISTORY_TEXT, 'info', 'history');
      this.markStarted();
    }
  }

  /** One poll: rows after the cursor (the whole thread while the cursor is 0). */
  private async poll(): Promise<boolean> {
    const gen = this.generation;
    const id = this.session.id;
    const res = await getConversation(id, this.cursor > 0 ? this.cursor : null);
    if (gen !== this.generation || id !== this.session.id) return false;
    if (this.historyPending) {
      this.historyPending = false;
      this.clearNotice('history');
      this.applyServerName(res.conversation_name);
      const fresh = this.ingest(res.messages, false);
      // Still no messages: the intro is back in view from the top.
      if (this.els.intro.hidden) this.scroller.toBottom();
      else this.scroller.toTop();
      return fresh > 0;
    }
    return this.ingest(res.messages, true) > 0;
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /** Send a visitor message and stream the Avatar's reply. */
  async send(text: string): Promise<void> {
    const message = text.trim();
    if (!message || this.inFlight) {
      this.composer.focus();
      return;
    }
    const gen = this.generation;
    const conversationId = this.session.id;
    this.inFlight = true;
    this.composer.setBusy(true);
    this.poller.markActivity();
    this.clearNotice('send');

    const opts = this.renderOpts(true);
    const pending = createPendingVisitorMessage(message, opts);
    this.els.thread.appendChild(pending);
    const reply = new StreamingAvatarMessage({
      ...opts,
      onUpdate: () => {
        if (gen === this.generation) this.scroller.contentChanged(true);
      },
    });
    this.els.thread.appendChild(reply.element);
    this.syncIntro();
    this.scroller.toBottom();
    this.composer.focus();

    const since = this.cursor;
    const controller = new AbortController();
    this.abort = controller;
    let confirmed = false;

    try {
      const events = streamChat(
        { conversation_id: conversationId, message, name: this.visitorName() },
        { signal: controller.signal },
      );
      for await (const ev of events) {
        if (gen !== this.generation) return;
        if (ev.type === 'start') {
          confirmMessage(pending, ev.visitor_message);
          // The confirmed bubble has its timestamp now: place the day separator
          // while the reply streams (not when it completes, which made the thread jump).
          updateDaySeparators(this.els.thread);
          confirmed = true;
          this.markStarted();
          continue;
        }
        reply.handle(ev);
        if (ev.type === 'done') {
          this.announce(`Avatar: ${truncate(plainText(ev.message.content), 240)}`);
        } else if (ev.type === 'error') {
          // Nothing more is coming for this reply: pin it in place.
          reply.element.removeAttribute('data-pending');
          this.announce(ev.detail);
        }
      }
    } catch (err) {
      if (gen !== this.generation || isAbortError(err)) return;
      if (err instanceof StreamInterruptedError) {
        // The server finishes the run and stores the reply; the next poll brings it.
        reply.fail(INTERRUPTED_TEXT);
        reply.element.removeAttribute('data-pending');
        this.orphanReply = reply;
        this.orphanSince = since;
        if (!confirmed) {
          pending.removeAttribute('data-pending');
          this.orphanVisitor = pending;
        }
        this.markStarted();
        this.poller.pollSoon(1500);
      } else {
        // Nothing was stored (rate limited / rejected / unreachable): restore the draft.
        pending.remove();
        reply.remove();
        this.syncIntro();
        if (err instanceof RateLimitedError) {
          this.showNotice(err.detail || RATE_LIMIT_MESSAGE, 'rate-limit', 'send');
        } else {
          const detail = err instanceof ApiError ? err.detail : 'Something went wrong. Please try again.';
          this.showNotice(detail, 'error', 'send');
        }
        if (!this.composer.value.trim()) this.composer.setValue(message);
      }
    } finally {
      if (gen === this.generation) {
        this.inFlight = false;
        this.abort = null;
        this.composer.setBusy(false);
        this.composer.focus();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------------

  /** Clear the thread and start a new conversation (the old one stays on the server). */
  reset(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = null;
    this.inFlight = false;
    this.composer.setBusy(false);
    this.poller.stop();
    this.poller.resetActivity();
    this.session.reset();
    this.cursor = 0;
    this.started = false;
    this.historyPending = false;
    this.orphanReply = null;
    this.orphanVisitor = null;
    this.orphanSince = 0;
    this.clearUnseen();
    for (const child of Array.from(this.els.thread.children)) {
      if (child !== this.els.intro) child.remove();
    }
    this.els.thread.dataset.state = 'ready';
    this.syncIntro();
    this.scroller.toTop();
    this.announce('Started a new conversation.');
    this.refocus();
  }
}
