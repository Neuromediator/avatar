/**
 * The inbox sidebar (mockup `.sidebar`): title + total, search, filter chips
 * (All / Needs you · n / Unread · n) and the conversation list as a listbox of
 * `.convo-item` rows (most recent activity first). Rows are reconciled in
 * place on every refresh so selection, scroll position, search and filter
 * survive the 10 s poll.
 */
import type { ConversationSummary } from '../shared/api';
import { clear, el, icon } from '../shared/dom';
import { formatFullTimestamp, formatInboxTime } from '../shared/format';
import { fillVisitorToken } from '../shared/messages';
import { displayName } from './util';

export type InboxFilter = 'all' | 'attention' | 'unread';

/** Unread / attention as displayed (the dashboard zeroes them for the thread being viewed). */
export interface RowState {
  unread: number;
  attention: boolean;
}

export interface InboxOptions {
  /** A row was clicked / tapped. */
  onSelect: (conversationId: string) => void;
  /** Enter in the search field (open the first match when nothing is active). */
  onSearchEnter: () => void;
  /** Retry after a failed first load. */
  onRetry: () => void;
  /** Effective unread/attention for a row. */
  rowState: (s: ConversationSummary) => RowState;
}

export class Inbox {
  readonly element: HTMLElement;
  readonly list: HTMLDivElement;
  readonly searchInput: HTMLInputElement;
  private readonly opts: InboxOptions;
  private readonly countBadge: HTMLSpanElement;
  private readonly chips: Record<InboxFilter, HTMLButtonElement>;
  private readonly chipCounts: Record<'attention' | 'unread', HTMLSpanElement>;
  private readonly status: HTMLDivElement;
  private readonly emptyEl: HTMLDivElement;
  private readonly rows = new Map<string, { node: HTMLDivElement; sig: string }>();
  private items: ConversationSummary[] = [];
  private activeId: string | null = null;
  private loaded = false;
  private filter: InboxFilter = 'all';
  private query = '';
  /** Rows opened while the current filter/search is on stay visible (no rows vanishing under the cursor). */
  private readonly sticky = new Set<string>();

  constructor(opts: InboxOptions) {
    this.opts = opts;

    this.countBadge = el('span', { class: 'count-badge', 'aria-label': '0 conversations' }, '0');
    this.searchInput = el('input', {
      type: 'search',
      class: 'search-input',
      placeholder: 'Search visitors & messages…',
      'aria-label': 'Search conversations',
      autocomplete: 'off',
      spellcheck: 'false',
      enterkeyhint: 'search',
    });

    this.chipCounts = {
      attention: el('span', { class: 'chip-count' }, '0'),
      unread: el('span', { class: 'chip-count' }, '0'),
    };
    const chip = (filter: InboxFilter, ...children: (Node | string)[]): HTMLButtonElement => {
      const b = el('button', { type: 'button', class: 'filter-chip', 'data-filter': filter, 'aria-pressed': 'false' }, ...children);
      b.addEventListener('click', () => this.setFilter(this.filter === filter && filter !== 'all' ? 'all' : filter));
      return b;
    };
    this.chips = {
      all: chip('all', 'All'),
      attention: chip('attention', el('span', { class: 'dot-y', 'aria-hidden': 'true' }), 'Needs you · ', this.chipCounts.attention),
      unread: chip('unread', 'Unread · ', this.chipCounts.unread),
    };

    this.status = el('div', { class: 'inbox-status', role: 'status', hidden: true });
    this.list = el('div', {
      class: 'convo-list scroll',
      role: 'listbox',
      id: 'convoList',
      'aria-label': 'Conversations, most recent first',
      tabindex: '0',
    });
    this.emptyEl = el('div', { class: 'inbox-empty', hidden: true });

    this.element = el('aside', { class: 'sidebar', 'aria-label': 'Inbox' },
      el('div', { class: 'sidebar-head' },
        el('div', { class: 'sidebar-title' },
          el('h2', null, icon('inbox'), 'Conversations'),
          this.countBadge),
        el('div', { class: 'search' },
          icon('search', 'icon--sm'),
          this.searchInput),
        el('div', { class: 'filter-row', role: 'group', 'aria-label': 'Filter conversations' },
          this.chips.all, this.chips.attention, this.chips.unread)),
      this.status,
      this.list,
    );
    this.list.appendChild(this.emptyEl);
    this.showLoading();
    this.paintChips();

    this.searchInput.addEventListener('input', () => {
      this.query = this.searchInput.value.trim().toLowerCase();
      this.sticky.clear();
      this.render();
    });
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.searchInput.value) {
        e.preventDefault();
        e.stopPropagation();
        this.searchInput.value = '';
        this.query = '';
        this.sticky.clear();
        this.render();
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        this.opts.onSearchEnter();
      }
    });
    this.list.addEventListener('click', (e) => {
      const row = (e.target as Element).closest<HTMLElement>('.convo-item');
      if (row?.dataset.id) this.opts.onSelect(row.dataset.id);
    });
  }

  // ---- data ----------------------------------------------------------------

  /** Replace the conversation list (already sorted most recent first). */
  setItems(items: ConversationSummary[]): void {
    this.items = items;
    this.loaded = true;
    this.status.hidden = true;
    this.render();
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  setActive(id: string | null): void {
    this.activeId = id;
    if (id && (this.filter !== 'all' || this.query)) this.sticky.add(id);
    this.render();
    this.scrollActiveIntoView();
  }

  /** Re-paint rows (e.g. after a local read / attention change). */
  refresh(): void {
    this.render();
  }

  /** Ids of the rows currently shown, top to bottom (keyboard navigation order). */
  visibleIds(): string[] {
    return this.visibleItems().map((s) => s.conversation_id);
  }

  /** Show a connection problem above the list (keeps the current rows). */
  showStatus(text: string | null): void {
    clear(this.status);
    if (!text) {
      this.status.hidden = true;
      return;
    }
    this.status.append(icon('alert', 'icon--sm'), el('span', null, text));
    this.status.hidden = false;
  }

  /** First load failed: an inline error with Retry. */
  showLoadError(text: string): void {
    this.clearRows();
    this.setEmpty('alert', "Couldn't load conversations", text, 'Retry');
  }

  showLoading(): void {
    this.clearRows();
    clear(this.emptyEl);
    this.emptyEl.className = 'inbox-loading';
    this.emptyEl.hidden = false;
    for (let i = 0; i < 5; i++) {
      this.emptyEl.appendChild(el('div', { class: 'skeleton-row', 'aria-hidden': 'true' },
        el('span', { class: 'sk sk-token' }),
        el('span', { class: 'sk-lines' }, el('span', { class: 'sk sk-line' }), el('span', { class: 'sk sk-line sk-line--short' }))));
    }
    this.emptyEl.appendChild(el('span', { class: 'visually-hidden' }, 'Loading conversations…'));
  }

  scrollActiveIntoView(): void {
    if (!this.activeId) return;
    const row = this.rows.get(this.activeId)?.node;
    row?.scrollIntoView({ block: 'nearest' });
  }

  focusList(): void {
    this.list.focus({ preventScroll: true });
  }

  // ---- filter --------------------------------------------------------------

  setFilter(filter: InboxFilter): void {
    if (this.filter === filter) return;
    this.filter = filter;
    this.sticky.clear();
    if (this.activeId && filter !== 'all') this.sticky.add(this.activeId);
    this.list.scrollTop = 0;
    this.render();
  }

  private matchesFilter(s: ConversationSummary): boolean {
    const st = this.opts.rowState(s);
    if (this.filter === 'attention') return st.attention;
    if (this.filter === 'unread') return st.unread > 0;
    return true;
  }

  private matchesQuery(s: ConversationSummary): boolean {
    if (!this.query) return true;
    const hay = `${s.conversation_name ?? ''}\n${displayName(s.conversation_id, s.conversation_name)}\n${s.preview ?? ''}\n${s.conversation_id}`.toLowerCase();
    return hay.includes(this.query);
  }

  private visibleItems(): ConversationSummary[] {
    return this.items.filter((s) => {
      if (this.sticky.has(s.conversation_id)) return true;
      return this.matchesFilter(s) && this.matchesQuery(s);
    });
  }

  // ---- rendering -----------------------------------------------------------

  private paintChips(): void {
    (Object.keys(this.chips) as InboxFilter[]).forEach((f) => {
      const on = f === this.filter;
      this.chips[f].classList.toggle('is-on', on);
      this.chips[f].setAttribute('aria-pressed', String(on));
    });
    this.countBadge.hidden = !this.loaded;
    if (!this.loaded) {
      this.chipCounts.attention.textContent = '–';
      this.chipCounts.unread.textContent = '–';
      return;
    }
    let attention = 0;
    let unread = 0;
    for (const s of this.items) {
      const st = this.opts.rowState(s);
      if (st.attention) attention++;
      if (st.unread > 0) unread++;
    }
    this.chipCounts.attention.textContent = String(attention);
    this.chipCounts.unread.textContent = String(unread);
    this.chips.attention.classList.toggle('has-items', attention > 0);
    const total = this.items.length;
    this.countBadge.textContent = String(total);
    this.countBadge.setAttribute('aria-label', `${total} conversation${total === 1 ? '' : 's'}`);
  }

  private clearRows(): void {
    this.rows.forEach(({ node }) => node.remove());
    this.rows.clear();
    this.list.removeAttribute('aria-activedescendant');
  }

  private setEmpty(iconName: 'inbox' | 'search' | 'spark' | 'check2' | 'alert', title: string, text: string, action?: string): void {
    clear(this.emptyEl);
    this.emptyEl.className = 'inbox-empty';
    this.emptyEl.append(
      el('span', { class: 'inbox-empty-icon', 'aria-hidden': 'true' }, icon(iconName)),
      el('p', { class: 'inbox-empty-title' }, title),
      el('p', { class: 'inbox-empty-text' }, text),
    );
    if (action) {
      const btn = el('button', { type: 'button', class: 'btn btn--secondary btn--sm' }, icon('reset', 'icon--sm'), action);
      btn.addEventListener('click', () => this.opts.onRetry());
      this.emptyEl.appendChild(btn);
    }
    this.emptyEl.hidden = false;
  }

  private render(): void {
    if (!this.loaded) return;
    this.paintChips();
    const visible = this.visibleItems();
    const keep = new Set(visible.map((s) => s.conversation_id));

    // Drop rows that are no longer shown.
    for (const [id, entry] of this.rows) {
      if (!keep.has(id)) {
        entry.node.remove();
        this.rows.delete(id);
      }
    }

    // Create / update rows and put them in order (moving only what moved).
    let cursor: Element | null = this.list.firstElementChild;
    for (const s of visible) {
      let entry = this.rows.get(s.conversation_id);
      if (!entry) {
        entry = { node: el('div', { class: 'convo-item', role: 'option', 'data-id': s.conversation_id }), sig: '' };
        entry.node.id = `convo-${s.conversation_id}`;
        this.rows.set(s.conversation_id, entry);
      }
      this.paintRow(entry, s);
      if (cursor === this.emptyEl) cursor = cursor.nextElementSibling;
      if (entry.node !== cursor) this.list.insertBefore(entry.node, cursor);
      else cursor = cursor.nextElementSibling;
    }

    // Active descendant for assistive tech.
    if (this.activeId && this.rows.has(this.activeId)) {
      this.list.setAttribute('aria-activedescendant', `convo-${this.activeId}`);
    } else {
      this.list.removeAttribute('aria-activedescendant');
    }

    // Empty states.
    if (visible.length === 0) {
      if (this.items.length === 0) {
        this.setEmpty('inbox', 'No conversations yet', 'When visitors chat with your Avatar, their threads land here, newest first.');
      } else if (this.query) {
        this.setEmpty('search', 'No matches', 'Nothing matches that search. Try a name, a phrase or a conversation id.');
      } else if (this.filter === 'attention') {
        this.setEmpty('spark', 'Nothing needs you', 'When the Avatar asks for you, the thread shows up here.');
      } else {
        this.setEmpty('check2', "You're all caught up", 'No unread conversations right now.');
      }
    } else {
      this.emptyEl.hidden = true;
    }
  }

  private paintRow(entry: { node: HTMLDivElement; sig: string }, s: ConversationSummary): void {
    const st = this.opts.rowState(s);
    const active = s.conversation_id === this.activeId;
    const timeLabel = formatInboxTime(s.last_message_at);
    const sig = [s.conversation_name ?? '', s.preview, timeLabel, st.unread, st.attention, active].join('\u0001');
    const node = entry.node;
    node.classList.toggle('is-unread', st.unread > 0);
    node.classList.toggle('is-attention', st.attention);
    node.classList.toggle('is-active', active);
    node.setAttribute('aria-selected', String(active));
    if (entry.sig === sig) return;
    entry.sig = sig;

    const name = displayName(s.conversation_id, s.conversation_name);
    const token = el('span', { class: 'avatar-initials', 'aria-hidden': 'true' });
    fillVisitorToken(token, s.conversation_name);

    let marker: Node;
    if (st.attention) {
      // The pill at full desktop width; the compact yellow dot (mockup) where the
      // sidebar is narrow, so the preview keeps its room (CSS picks one).
      const both = document.createDocumentFragment();
      both.append(
        el('span', { class: 'badge badge--attention' }, icon('spark', 'badge-icon'), 'Needs you'),
        el('span', { class: 'badge badge--dot is-attention attn-dot', title: 'Needs you' },
          el('span', { class: 'visually-hidden' }, 'Needs you')));
      marker = both;
    } else if (st.unread > 0) {
      marker = el('span', { class: 'badge badge--dot', title: `${st.unread} unread` },
        el('span', { class: 'visually-hidden' }, `${st.unread} unread`));
    } else {
      marker = el('span', { class: 'convo-read', title: 'Read' }, icon('check2', 'icon--sm'),
        el('span', { class: 'visually-hidden' }, 'Read'));
    }

    const time = el('span', { class: 'msg-time', title: formatFullTimestamp(s.last_message_at) }, timeLabel);
    clear(node);
    node.append(
      token,
      el('div', { class: 'convo-main' },
        el('div', { class: 'convo-top' }, el('span', { class: 'convo-name' }, name)),
        el('div', { class: 'convo-preview' }, s.preview?.trim() || 'No messages yet')),
      el('div', { class: 'convo-side' }, time, marker),
    );
  }
}
