/**
 * Keeps the conversation pinned to the latest message - but only while the
 * reader is already near the bottom. If they have scrolled up to read, new
 * content does not yank them down; a "Latest" pill offers the jump instead.
 *
 * While the intro (empty thread) is shown, nothing sticks to the bottom: the
 * intro reads from the top (portrait + headline first), also on short
 * viewports where it is taller than the conversation area.
 */

/** Distance from the bottom (px) that still counts as "at the bottom". */
const STICK_THRESHOLD = 96;

export class ThreadScroller {
  private readonly scroller: HTMLElement;
  private readonly jump: HTMLElement | null;
  /** Follow new content (the reader is at the bottom). Off until the first message. */
  private stick = false;
  /** The intro is shown (no messages yet): keep the top in view. */
  private intro = true;
  private frame = 0;

  constructor(scroller: HTMLElement, jumpButton: HTMLElement | null, onJump?: () => void) {
    this.scroller = scroller;
    this.jump = jumpButton;
    scroller.addEventListener('scroll', () => {
      if (this.intro) return;
      this.stick = this.distanceFromBottom() <= STICK_THRESHOLD;
      if (this.stick) this.hideJump();
    }, { passive: true });
    this.jump?.addEventListener('click', () => {
      this.toBottom();
      onJump?.();
    });
    // Keep the bottom in view when the viewport resizes (mobile keyboard,
    // rotation) if the reader was at the bottom.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        if (this.stick && !this.intro) this.snap();
      }).observe(scroller);
    }
  }

  private distanceFromBottom(): number {
    const s = this.scroller;
    return s.scrollHeight - s.scrollTop - s.clientHeight;
  }

  /** True when the reader is at (or near) the latest message. */
  get isAtBottom(): boolean {
    return this.stick;
  }

  private snap(): void {
    this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  /** Jump to the latest message now and re-arm auto-stick. */
  toBottom(): void {
    this.stick = true;
    this.hideJump();
    this.snap();
    // Once more after layout settles (fonts, images, Markdown re-render).
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.stick) this.snap();
    });
  }

  /**
   * Content changed (new message, streamed text, tool row). Follow it if the
   * reader was at the bottom; otherwise surface the "Latest" pill when
   * `notify` is set (a new message, not a streamed chunk).
   */
  contentChanged(notify = false): void {
    if (this.stick) {
      this.snap();
      return;
    }
    if (notify) this.showJump();
  }

  /**
   * The intro is shown (no messages) or gone (the first message arrived).
   * Showing it scrolls to the top and stops following the bottom; hiding it
   * re-arms auto-stick for the thread.
   */
  setIntro(showing: boolean): void {
    if (showing === this.intro) return;
    this.intro = showing;
    if (showing) this.toTop();
    else this.stick = true;
  }

  /** Scroll to the top (e.g. after a reset, the intro is shown). */
  toTop(): void {
    this.stick = false;
    this.hideJump();
    this.scroller.scrollTop = 0;
  }

  private showJump(): void {
    if (this.jump) this.jump.hidden = false;
  }

  private hideJump(): void {
    if (this.jump) this.jump.hidden = true;
  }
}
