/** Shared choices for the saved default and the current listening timer. */
export const SLEEP_MINUTES = [15, 30, 45, 60, 90];

export function parseSleepMinutes(raw: string): number {
  const minutes = Number(raw);
  if (raw.trim() === "" || (minutes !== 0 && !SLEEP_MINUTES.includes(minutes))) {
    throw new Error("Invalid sleep timer duration");
  }
  return minutes;
}

/** Compact label shared by the timer menu and countdown. */
export function fmtSleep(min: number): string {
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? `${h}h` : `${h}h${m}m`;
  }
  return `${min}m`;
}

/** A temporary Off choice is still a choice. Only expiry or stopping ends it;
 * pause/resume, chapter changes, and preference sync must not rearm the timer. */
export class ListeningSleepTimer {
  private started = false;
  private remaining = 0;

  get active(): boolean { return this.started; }

  start(defaultMinutes: number): number | null {
    if (this.started) return null;
    this.choose(defaultMinutes * 60);
    return defaultMinutes;
  }

  choose(seconds: number): void {
    this.started = true;
    this.remaining = seconds;
  }

  observe(seconds: number, active = false): void {
    if (this.remaining > 0 && seconds <= 0) this.started = false;
    else if (seconds > 0 || active) this.started = true;
    this.remaining = seconds;
  }

  reset(): void {
    this.started = false;
    this.remaining = 0;
  }
}
