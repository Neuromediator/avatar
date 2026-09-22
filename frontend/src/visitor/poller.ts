/**
 * Adaptive poll scheduler for the visitor thread (picks up the owner's
 * async messages): every 10 s, easing to every 60 s once 5 minutes pass with
 * no activity, and back to 10 s on the next activity (a visitor send or a new
 * message received). Ticks are skipped while `canPoll()` is false (a send /
 * stream is in flight) and simply re-scheduled.
 */

export const POLL_FAST_MS = 10_000;
export const POLL_SLOW_MS = 60_000;
export const POLL_QUIET_MS = 5 * 60_000;

export interface PollerOptions {
  /** Fetch updates. Resolve true when new messages arrived (counts as activity). */
  poll: () => Promise<boolean>;
  /** False while polling is paused (e.g. a send/stream is in flight). */
  canPoll: () => boolean;
  fastMs?: number;
  slowMs?: number;
  quietMs?: number;
  /** Clock (overridable for tests). */
  now?: () => number;
}

export class Poller {
  private readonly opts: Required<Omit<PollerOptions, 'poll' | 'canPoll'>> & Pick<PollerOptions, 'poll' | 'canPoll'>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dueAt = 0;
  private running = false;
  private polling = false;
  private lastActivity: number;

  constructor(options: PollerOptions) {
    this.opts = {
      fastMs: POLL_FAST_MS,
      slowMs: POLL_SLOW_MS,
      quietMs: POLL_QUIET_MS,
      now: () => Date.now(),
      ...options,
    };
    this.lastActivity = this.opts.now();
  }

  /** Whether the scheduler is active. */
  get isRunning(): boolean {
    return this.running;
  }

  /** The interval that applies right now (fast, or slow after the quiet period). */
  currentInterval(): number {
    return this.opts.now() - this.lastActivity >= this.opts.quietMs ? this.opts.slowMs : this.opts.fastMs;
  }

  /** Start polling (no-op if already running). The first poll happens one interval from now. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(this.currentInterval());
  }

  /** Stop polling and clear any pending tick. */
  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  /**
   * Record activity: back to the fast cadence. A pending slow tick is pulled in
   * to at most one fast interval from now.
   */
  markActivity(): void {
    this.lastActivity = this.opts.now();
    if (!this.running || this.polling) return;
    const fastDue = this.opts.now() + this.opts.fastMs;
    if (!this.timer || this.dueAt > fastDue) this.schedule(this.opts.fastMs);
  }

  /** Reset the quiet clock without touching the schedule (e.g. new conversation). */
  resetActivity(): void {
    this.lastActivity = this.opts.now();
  }

  /** Poll as soon as possible (e.g. the tab became visible, or after a dropped stream). */
  pollSoon(delayMs = 0): void {
    if (!this.running || this.polling) return;
    const due = this.opts.now() + delayMs;
    if (!this.timer || this.dueAt > due) this.schedule(delayMs);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    if (!this.running) return;
    this.dueAt = this.opts.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    if (!this.opts.canPoll()) {
      this.schedule(this.currentInterval());
      return;
    }
    this.polling = true;
    try {
      const gotNew = await this.opts.poll();
      if (gotNew) this.lastActivity = this.opts.now();
    } catch {
      /* transient failure: try again next interval */
    } finally {
      this.polling = false;
      this.schedule(this.currentInterval());
    }
  }
}
