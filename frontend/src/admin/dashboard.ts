/**
 * The authenticated admin dashboard (mockup "Admin Dashboard.html"): app bar,
 * inbox sidebar and the thread panel, plus the behaviour that ties them
 * together - selection and keyboard navigation, the 10 s live refresh,
 * mark-read on open, "Mark resolved", posting as the human, the unread count
 * in the tab title, and the mobile master/detail flow with browser Back.
 */
import {
  ApiError,
  UnauthorizedError,
  adminLogout,
  isAbortError,
  listConversations,
  openConversation,
  postHumanMessage,
  resolveConversation,
  type AppConfig,
  type ConversationSummary,
} from '../shared/api';
import { brandMark, el, icon } from '../shared/dom';
import { createHumanAvatar } from '../shared/messages';
import { bindThemeToggle } from '../shared/theme';
import { Inbox, type RowState } from './inbox';
import { ThreadPanel } from './thread';
import {
  MOBILE_QUERY,
  activityTime,
  displayName,
  getResolvedUpTo,
  hasPendingPush,
  isMobileLayout,
  isTouchDevice,
  setResolvedUpTo,
} from './util';

/** Inbox refresh cadence (the admin keeps a fast, steady poll). */
const POLL_MS = 10_000;
/** Keyboard navigation opens the thread after this pause (holding an arrow skims instead of opening every row). */
const KEY_OPEN_DELAY_MS = 140;

export interface DashboardOptions {
  cfg: AppConfig;
  /** A 401 anywhere: back to the login gate. */
  onUnauthorized: () => void;
  /** The owner signed out. */
  onSignedOut: () => void;
}

type SelectSource = 'click' | 'keyboard' | 'search' | 'history';

interface OpenState {
  id: string;
  /** last_message_at from the inbox when this thread was last fetched (poll compares against it). */
  lastMessageAt: string | null;
  /** The row needed attention at the moment it was opened. */
  attentionAtOpen: boolean;
  loaded: boolean;
}

export class Dashboard {
  readonly element: HTMLElement;
  private readonly opts: DashboardOptions;
  private readonly inbox: Inbox;
  private readonly thread: ThreadPanel;
  private readonly baseTitle: string;
  /** Polite screen-reader announcements (new conversations / messages arriving on refresh). */
  private readonly live: HTMLElement;
  private items: ConversationSummary[] = [];
  /** Inbox as of the previous successful poll (null until the first one: nothing is announced on load). */
  private prevSeen: Map<string, { at: string; attention: boolean }> | null = null;
  private open: OpenState | null = null;
  private pollTimer = 0;
  private keyTimer = 0;
  private polling = false;
  private destroyed = false;
  private loadSeq = 0;
  private loadAbort: AbortController | null = null;
  private sending = 0;
  private refreshAfterSend = false;
  private readonly mql: MediaQueryList;
  private readonly cleanups: (() => void)[] = [];

  constructor(opts: DashboardOptions) {
    this.opts = opts;
    this.baseTitle = document.title.replace(/^\(\d+\)\s*/, '') || 'Avatar Admin';
    this.mql = matchMedia(MOBILE_QUERY);

    this.inbox = new Inbox({
      onSelect: (id) => this.select(id, 'click'),
      onSearchEnter: () => {
        const ids = this.inbox.visibleIds();
        const target = this.open && ids.includes(this.open.id) ? this.open.id : ids[0];
        if (target) this.select(target, 'click');
      },
      onRetry: () => void this.poll(true),
      rowState: (s) => this.rowState(s),
    });

    this.thread = new ThreadPanel({
      cfg: opts.cfg,
      onSend: (text) => this.send(text),
      onResolve: () => void this.resolve(),
      onBack: () => this.back(),
      onRetry: () => {
        if (this.open) void this.loadThread(this.open.id, 'open');
      },
    });

    // ---- app bar ----
    const signOut = el('button', { type: 'button', class: 'icon-btn signout-btn', title: 'Sign out', 'aria-label': 'Sign out' },
      icon('logout', 'icon--sm'));
    signOut.addEventListener('click', () => void this.signOut());
    const themeToggle = el('button', { type: 'button', class: 'icon-btn', id: 'themeToggle', title: 'Toggle light / dark' });
    this.cleanups.push(bindThemeToggle(themeToggle));
    const appbar = el('header', { class: 'appbar' },
      el('div', { class: 'brand' },
        el('span', { class: 'brand-mark', 'aria-hidden': 'true' }, brandMark(20)),
        el('div', { class: 'brand-name' }, 'Avatar'),
        el('span', { class: 'admin-pill' }, 'Admin')),
      el('div', { class: 'appbar-right' },
        el('span', { class: 'secure-note' }, icon('shield', 'icon--sm'), 'Secure session'),
        el('span', { class: 'divider-v', 'aria-hidden': 'true' }),
        themeToggle,
        el('div', { class: 'owner-chip', title: `Signed in as ${opts.cfg.owner_name}` },
          el('span', null, 'You'),
          createHumanAvatar(false, 'owner-avatar')),
        signOut));

    this.live = el('div', { class: 'visually-hidden', 'aria-live': 'polite', 'aria-atomic': 'true' });
    this.element = el('div', { class: 'admin-shell', 'data-view': 'inbox' },
      appbar,
      el('div', { class: 'workspace' }, this.inbox.element, this.thread.element),
      this.live);

    // ---- global listeners ----
    this.listen(document, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    this.listen(window, 'popstate', (e) => this.onPopState(e as PopStateEvent));
    this.listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.poll();
    });
    const onLayout = (): void => this.onLayoutChange();
    this.mql.addEventListener('change', onLayout);
    this.cleanups.push(() => this.mql.removeEventListener('change', onLayout));
  }

  // ---- lifecycle -------------------------------------------------------------

  mount(root: HTMLElement): void {
    root.replaceChildren(this.element);
    document.body.dataset.screen = 'dashboard';
    if (history.state?.adminView === 'thread') history.replaceState(null, '');
    if (!isTouchDevice()) this.inbox.focusList();
    void this.poll(true);
  }

  destroy(): void {
    this.destroyed = true;
    window.clearTimeout(this.pollTimer);
    window.clearTimeout(this.keyTimer);
    this.loadAbort?.abort();
    this.cleanups.forEach((fn) => fn());
    this.thread.composer.destroy();
    this.element.remove();
    document.title = this.baseTitle;
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.cleanups.push(() => target.removeEventListener(type, fn));
  }

  private fail(err: unknown): boolean {
    if (err instanceof UnauthorizedError) {
      if (!this.destroyed) this.opts.onUnauthorized();
      return true;
    }
    return false;
  }

  // ---- state helpers ---------------------------------------------------------

  private summary(id: string): ConversationSummary | undefined {
    return this.items.find((s) => s.conversation_id === id);
  }

  /** True while the owner can actually see this conversation's thread. */
  private isViewing(id: string): boolean {
    return this.open?.id === id && document.visibilityState === 'visible'
      && (!isMobileLayout() || this.element.dataset.view === 'thread');
  }

  /**
   * Unread/attention as shown: the thread being viewed counts as read once it
   * has loaded (opening it marked it read server-side; later activity is
   * re-fetched, which marks it read). A thread still loading, or whose load
   * failed, keeps its markers: nothing has been cleared.
   */
  private rowState(s: ConversationSummary): RowState {
    if (this.isViewing(s.conversation_id) && this.open?.loaded) return { unread: 0, attention: false };
    return { unread: s.unread_count, attention: s.needs_attention };
  }

  /** The open thread has activity the panel has not fetched yet. */
  private isStale(id: string): boolean {
    const s = this.summary(id);
    return !!s && !!this.open && this.open.id === id && this.open.loaded && s.last_message_at !== this.open.lastMessageAt;
  }

  private updateTitle(): void {
    const unread = this.items.filter((s) => this.rowState(s).unread > 0).length;
    document.title = unread > 0 ? `(${unread}) ${this.baseTitle}` : this.baseTitle;
  }

  private sortItems(): void {
    this.items.sort((a, b) => activityTime(b) - activityTime(a));
  }

  /** Politely announce text to screen readers (cleared first so a repeat is re-read). */
  private announce(text: string): void {
    if (this.destroyed || !text) return;
    this.live.textContent = '';
    requestAnimationFrame(() => {
      if (!this.destroyed) this.live.textContent = text;
    });
  }

  /**
   * After a refresh: announce what changed in the inbox since the previous
   * poll, once, highest priority first (needs you > new conversation > new
   * message). The thread being viewed is skipped (its new rows are announced
   * when merged) and the owner's own replies never count.
   */
  private announceInboxChanges(): void {
    const prev = this.prevSeen;
    if (!prev) return;
    const attention: ConversationSummary[] = [];
    const fresh: ConversationSummary[] = [];
    const updated: ConversationSummary[] = [];
    for (const s of this.items) {
      const id = s.conversation_id;
      if (this.isViewing(id)) continue;
      const before = prev.get(id);
      if (s.needs_attention && !before?.attention) attention.push(s);
      else if (!before && s.last_role !== 'human') fresh.push(s);
      else if (before && s.last_message_at !== before.at && s.last_role !== 'human' && s.unread_count > 0) updated.push(s);
    }
    const nameOf = (s: ConversationSummary): string => displayName(s.conversation_id, s.conversation_name);
    let text = '';
    if (attention.length) {
      text = attention.length === 1 ? `${nameOf(attention[0]!)} needs you` : `${attention.length} conversations need you`;
    } else if (fresh.length) {
      text = fresh.length === 1 ? `New conversation from ${nameOf(fresh[0]!)}` : `${fresh.length} new conversations`;
    } else if (updated.length) {
      text = updated.length === 1 ? `New message from ${nameOf(updated[0]!)}` : `New messages in ${updated.length} conversations`;
    }
    this.announce(text);
  }

  // ---- polling ---------------------------------------------------------------

  private schedulePoll(): void {
    window.clearTimeout(this.pollTimer);
    if (!this.destroyed) this.pollTimer = window.setTimeout(() => void this.poll(), POLL_MS);
  }

  /** Refresh the inbox; re-fetch the open thread when it has new activity. */
  private async poll(first = false): Promise<void> {
    if (this.destroyed || this.polling) return;
    this.polling = true;
    window.clearTimeout(this.pollTimer);
    if (first && !this.inbox.isLoaded) this.inbox.showLoading();
    try {
      const items = await listConversations();
      if (this.destroyed) return;
      this.items = items;
      this.sortItems();
      this.announceInboxChanges();
      this.prevSeen = new Map(items.map((s) => [s.conversation_id, { at: s.last_message_at, attention: s.needs_attention }]));
      this.inbox.setItems(this.items);
      this.inbox.showStatus(null);
      this.thread.setInboxEmpty(this.items.length === 0);
      this.afterListUpdate();
    } catch (err) {
      if (this.fail(err)) return;
      const detail = err instanceof ApiError ? err.detail : 'Something went wrong.';
      if (!this.inbox.isLoaded) this.inbox.showLoadError(detail);
      else this.inbox.showStatus('Connection lost. Retrying…');
    } finally {
      this.polling = false;
      this.schedulePoll();
    }
  }

  private afterListUpdate(): void {
    const open = this.open;
    if (open) {
      const s = this.summary(open.id);
      if (!s) {
        // The conversation disappeared (deleted server-side).
        this.open = null;
        this.inbox.setActive(null);
        this.thread.showEmpty();
        if (isMobileLayout()) this.setView('inbox');
      } else if (this.isStale(open.id) && this.isViewing(open.id)) {
        this.refreshOpen();
      }
    }
    this.updateTitle();
  }

  /** Re-fetch the open thread (deferred while the owner's own message is in flight). */
  private refreshOpen(): void {
    if (!this.open) return;
    if (this.sending) this.refreshAfterSend = true;
    else void this.loadThread(this.open.id, 'refresh');
  }

  // ---- selection -------------------------------------------------------------

  private select(id: string, source: SelectSource): void {
    const s = this.summary(id);
    if (!s) return;
    const mobile = isMobileLayout();

    if (this.open?.id !== id) {
      this.open = { id, lastMessageAt: null, attentionAtOpen: s.needs_attention, loaded: false };
      this.inbox.setActive(id);
      this.thread.beginOpen(s);
      window.clearTimeout(this.keyTimer);
      if (source === 'keyboard' || source === 'search') {
        this.keyTimer = window.setTimeout(() => void this.loadThread(id, 'open'), KEY_OPEN_DELAY_MS);
      } else {
        void this.loadThread(id, 'open');
      }
    } else if (!this.open.loaded) {
      // Re-selecting a row whose load failed / is pending: try again.
      window.clearTimeout(this.keyTimer);
      void this.loadThread(id, 'open');
    } else {
      this.inbox.scrollActiveIntoView();
      if (this.isStale(id)) this.refreshOpen();
    }

    if (mobile) {
      const wasThread = this.element.dataset.view === 'thread';
      this.setView('thread');
      if (source !== 'history') {
        const state = { adminView: 'thread', id };
        if (wasThread && history.state?.adminView === 'thread') history.replaceState(state, '');
        else history.pushState(state, '');
      }
      this.thread.onShown();
    }

    // Focus: keyboard / click on desktop -> composer (type straight away); search keeps its field.
    if (source === 'search') this.inbox.searchInput.focus({ preventScroll: true });
    else if (!mobile && !isTouchDevice()) this.thread.focusComposer();
    this.inbox.refresh();
    this.updateTitle();
  }

  /** Move the selection up/down the visible (filtered) list and open it. */
  private move(delta: 1 | -1, source: SelectSource): void {
    const ids = this.inbox.visibleIds();
    if (!ids.length) return;
    const current = this.open ? ids.indexOf(this.open.id) : -1;
    const next = current === -1
      ? (delta > 0 ? 0 : ids.length - 1)
      : Math.min(ids.length - 1, Math.max(0, current + delta));
    if (next === current) {
      this.inbox.scrollActiveIntoView();
      return;
    }
    this.select(ids[next]!, source);
  }

  /** GET /admin/api/conversations/{id}: marks every row read + clears attention, returns the rows. */
  private async loadThread(id: string, mode: 'open' | 'refresh'): Promise<void> {
    const seq = ++this.loadSeq;
    this.loadAbort?.abort();
    const abort = new AbortController();
    this.loadAbort = abort;
    const listStamp = this.summary(id)?.last_message_at ?? null;
    try {
      const res = await openConversation(id, { signal: abort.signal });
      if (this.destroyed || seq !== this.loadSeq || this.open?.id !== id) return;
      const open = this.open;
      const messages = [...res.messages].sort((a, b) => a.id - b.id);
      open.lastMessageAt = listStamp;

      // Opening marked everything read and cleared attention server-side.
      const s = this.summary(id);
      if (s) {
        s.unread_count = 0;
        s.needs_attention = false;
        if (res.conversation_name) s.conversation_name = res.conversation_name;
        s.message_count = Math.max(s.message_count, messages.length);
      }

      if (mode === 'open' || !open.loaded) {
        this.thread.render(id, res.conversation_name ?? s?.conversation_name ?? null, messages);
      } else {
        const added = this.thread.merge(res.conversation_name, messages);
        // Announce the visitor's / Avatar's new rows (the owner's own posts are confirmed via confirmHuman).
        const incoming = added.filter((n) => n.dataset.role === 'visitor' || n.dataset.role === 'avatar');
        if (incoming.length) {
          const who = displayName(id, res.conversation_name ?? s?.conversation_name ?? null);
          this.announce(incoming.length > 1
            ? `${incoming.length} new messages from ${who}`
            : incoming[0]!.dataset.role === 'avatar' ? `Avatar replied to ${who}` : `New message from ${who}`);
        }
      }
      open.loaded = true;
      this.thread.setAttention(open.attentionAtOpen || hasPendingPush(messages, getResolvedUpTo(id)));
      this.inbox.refresh();
      this.updateTitle();
    } catch (err) {
      if (isAbortError(err) || this.destroyed || seq !== this.loadSeq) return;
      if (this.fail(err)) return;
      if (mode === 'refresh' && this.open?.loaded) return; // keep what is shown; the next poll retries
      if (err instanceof ApiError && err.status === 404) {
        this.thread.showError('This conversation no longer exists.', false);
      } else {
        this.thread.showError(err instanceof ApiError ? err.detail : "Couldn't load this conversation.", true);
      }
    }
  }

  // ---- actions ---------------------------------------------------------------

  /** Post as the human. The Avatar does not react (SPEC Q&A #4). */
  private async send(text: string): Promise<void> {
    const open = this.open;
    if (!open) return;
    const id = open.id;
    const pending = this.thread.addPendingHuman(text);
    this.sending++;
    this.thread.composer.setBusy(true);
    try {
      const msg = await postHumanMessage(id, text);
      if (this.destroyed) return;
      if (this.open?.id === id) {
        this.thread.confirmHuman(pending, msg);
        // Replying resolves the ask.
        open.attentionAtOpen = false;
        this.thread.setAttention(false);
      } else {
        pending.remove();
      }
      const s = this.summary(id);
      if (s) {
        s.last_message_at = msg.created_at;
        s.last_role = 'human';
        s.message_count += 1;
        s.needs_attention = false;
        if (this.open?.id === id) open.lastMessageAt = msg.created_at;
        this.sortItems();
        this.inbox.setItems(this.items);
      }
    } catch (err) {
      if (this.fail(err)) return;
      if (this.open?.id === id) {
        this.thread.failHuman(pending, err instanceof ApiError ? `Not sent: ${err.detail}` : 'Not sent. Please try again.');
        if (!this.thread.composer.value) this.thread.composer.setValue(text);
      } else {
        pending.remove();
      }
    } finally {
      this.sending = Math.max(0, this.sending - 1);
      if (!this.destroyed) {
        this.thread.composer.setBusy(this.sending > 0);
        if (!this.sending && this.refreshAfterSend) {
          this.refreshAfterSend = false;
          this.refreshOpen();
        }
      }
    }
  }

  /** "Mark resolved": clear needs_attention without replying, and remember it locally. */
  private async resolve(): Promise<void> {
    const open = this.open;
    if (!open) return;
    const id = open.id;
    this.thread.setResolving(true);
    try {
      await resolveConversation(id);
      if (this.destroyed || this.open?.id !== id) return;
      setResolvedUpTo(id, this.thread.maxId());
      open.attentionAtOpen = false;
      const s = this.summary(id);
      if (s) s.needs_attention = false;
      this.thread.setAttention(false);
      this.inbox.refresh();
      if (!isTouchDevice()) this.thread.focusComposer();
    } catch (err) {
      if (this.fail(err)) return;
      this.thread.setResolving(false);
      this.thread.showNotice(err instanceof ApiError ? err.detail : "Couldn't mark this resolved.");
    }
  }

  private async signOut(): Promise<void> {
    try {
      await adminLogout();
    } catch {
      /* the cookie is cleared server-side; nothing else to do */
    }
    if (!this.destroyed) this.opts.onSignedOut();
  }

  // ---- keyboard --------------------------------------------------------------

  private onKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.isComposing) return;
    const target = e.target as HTMLElement | null;

    if (e.key === 'Escape' && isMobileLayout() && this.element.dataset.view === 'thread') {
      if (target === this.thread.composer.textarea && this.thread.composer.value) return;
      e.preventDefault();
      this.back();
      return;
    }
    // Enter on the focused inbox list: open the active (or first) conversation and go to the composer.
    if (e.key === 'Enter' && target === this.inbox.list && !e.shiftKey) {
      e.preventDefault();
      const ids = this.inbox.visibleIds();
      const id = this.open && ids.includes(this.open.id) ? this.open.id : ids[0];
      if (id) this.select(id, 'click');
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    // Reading inside the thread (the focused scroller or anything in it): let the browser scroll natively.
    if (this.thread.ownsReadingFocus(target)) return;

    const isComposer = target === this.thread.composer.textarea;
    const isSearch = target === this.inbox.searchInput;
    const editable = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (editable && !isSearch && !(isComposer && this.thread.composer.value === '')) return;

    e.preventDefault();
    this.move(e.key === 'ArrowDown' ? 1 : -1, isSearch ? 'search' : 'keyboard');
  }

  // ---- mobile master / detail -----------------------------------------------

  private setView(view: 'inbox' | 'thread'): void {
    if (this.element.dataset.view === view) return;
    const list = this.inbox.list;
    if (view === 'thread') this.element.dataset.listScroll = String(list.scrollTop);
    this.element.dataset.view = view;
    if (view === 'inbox') {
      const saved = Number(this.element.dataset.listScroll ?? 0);
      requestAnimationFrame(() => {
        list.scrollTop = saved;
        this.inbox.scrollActiveIntoView();
      });
    }
    this.inbox.refresh();
    this.updateTitle();
  }

  /** The thread head's back control (mobile). */
  private back(): void {
    if (history.state?.adminView === 'thread') history.back(); // popstate switches the view
    else this.setView('inbox');
  }

  private onPopState(e: PopStateEvent): void {
    const state = e.state as { adminView?: string; id?: string } | null;
    if (state?.adminView === 'thread' && state.id && this.summary(state.id)) {
      this.select(state.id, 'history');
    } else {
      this.setView('inbox');
    }
  }

  private onLayoutChange(): void {
    if (!isMobileLayout()) {
      // Desktop shows both panes.
      if (this.open) this.thread.onShown();
    } else if (!this.open) {
      this.setView('inbox');
    }
    this.inbox.refresh();
  }
}
