/**
 * The message composer shared by both screens (`.composer` = textarea +
 * `.btn-send`): auto-grows up to 160px, Enter sends, Shift+Enter inserts a
 * newline (Enter during IME composition is ignored), and the textarea keeps /
 * regains focus after every send - by Enter or by clicking the button.
 */

export interface ComposerOptions {
  textarea: HTMLTextAreaElement;
  /** The `.btn-send` button (optional). Disabled while busy/disabled (and while empty if `disableWhenEmpty`). */
  sendButton?: HTMLButtonElement | null;
  /**
   * Also disable the send button while the textarea is empty (default false:
   * the mockups show the purple send button at rest; an empty send just re-focuses).
   */
  disableWhenEmpty?: boolean;
  /**
   * Called with the trimmed text when the user sends. The textarea is cleared
   * and re-focused immediately; use {@link ComposerHandle.setValue} to restore
   * the text if sending fails.
   */
  onSend: (text: string) => void | Promise<void>;
  /** Max textarea height in px before it scrolls (default 160). */
  maxHeight?: number;
  /** Focus the textarea right away (default true). */
  autofocus?: boolean;
}

export interface ComposerHandle {
  readonly textarea: HTMLTextAreaElement;
  /** Current raw value. */
  readonly value: string;
  /** True while {@link setBusy}(true) is in effect. */
  readonly busy: boolean;
  /** Focus the textarea (without scrolling the page). */
  focus(): void;
  /** Clear the text (and re-grow). */
  clear(): void;
  /** Replace the text (e.g. restore after a failed send), re-grow, caret at end. */
  setValue(text: string): void;
  /**
   * Busy = a send/stream is in flight: sending is blocked and the button
   * disabled, but the textarea stays editable and focused (composer "sending" state).
   */
  setBusy(busy: boolean): void;
  /** Disabled = textarea and button disabled (composer "disabled" state). Focus is left to the caller. */
  setDisabled(disabled: boolean): void;
  /** Programmatically send the current text (same path as Enter). */
  submit(): void;
  /** Recompute the auto-grow height. */
  autoGrow(): void;
  /** Remove all listeners. */
  destroy(): void;
}

/** Wire a composer. Returns a handle for focus/busy/disabled control. */
export function createComposer(options: ComposerOptions): ComposerHandle {
  const { textarea, sendButton, onSend } = options;
  const maxHeight = options.maxHeight ?? 160;
  let busy = false;
  let disabled = false;

  const autoGrow = (): void => {
    textarea.style.height = 'auto';
    const full = textarea.scrollHeight;
    textarea.style.height = `${Math.min(full, maxHeight)}px`;
    textarea.style.overflowY = full > maxHeight ? 'auto' : 'hidden';
  };

  const syncButton = (): void => {
    if (!sendButton) return;
    sendButton.disabled = disabled || busy || (!!options.disableWhenEmpty && textarea.value.trim() === '');
  };

  const focus = (): void => {
    if (!disabled) textarea.focus({ preventScroll: true });
  };

  const submit = (): void => {
    const text = textarea.value.trim();
    if (!text || busy || disabled) {
      focus();
      return;
    }
    textarea.value = '';
    autoGrow();
    syncButton();
    focus();
    void Promise.resolve()
      .then(() => onSend(text))
      .catch((err: unknown) => console.error('[avatar] send failed', err))
      .finally(() => focus());
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter') return;
    // IME composition (e.g. CJK input): Enter confirms the candidate, never sends.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.shiftKey) return; // newline
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    submit();
  };

  const onInput = (): void => {
    autoGrow();
    syncButton();
  };

  // Keep focus in the textarea when the button is pressed (no blur flicker /
  // mobile keyboard bounce), then send on click.
  const onButtonDown = (e: MouseEvent): void => {
    e.preventDefault();
  };
  const onButtonClick = (e: MouseEvent): void => {
    e.preventDefault();
    submit();
  };

  textarea.addEventListener('keydown', onKeyDown);
  textarea.addEventListener('input', onInput);
  sendButton?.addEventListener('mousedown', onButtonDown);
  sendButton?.addEventListener('click', onButtonClick);
  if (sendButton && !sendButton.hasAttribute('type')) sendButton.type = 'button';

  autoGrow();
  syncButton();
  if (options.autofocus ?? true) focus();

  return {
    textarea,
    get value() {
      return textarea.value;
    },
    get busy() {
      return busy;
    },
    focus,
    clear() {
      textarea.value = '';
      autoGrow();
      syncButton();
    },
    setValue(text: string) {
      textarea.value = text;
      autoGrow();
      syncButton();
      const end = text.length;
      textarea.setSelectionRange(end, end);
    },
    setBusy(next: boolean) {
      busy = next;
      textarea.closest('.composer')?.classList.toggle('is-busy', busy);
      syncButton();
    },
    setDisabled(next: boolean) {
      disabled = next;
      textarea.disabled = next;
      textarea.closest('.composer')?.classList.toggle('is-disabled', next);
      syncButton();
    },
    submit,
    autoGrow,
    destroy() {
      textarea.removeEventListener('keydown', onKeyDown);
      textarea.removeEventListener('input', onInput);
      sendButton?.removeEventListener('mousedown', onButtonDown);
      sendButton?.removeEventListener('click', onButtonClick);
    },
  };
}
