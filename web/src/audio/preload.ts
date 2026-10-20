export type AudioPreloadStrategy = "book" | "ahead" | "off";
export type AudioCacheState =
  | "checking" | "cached" | "queued" | "downloading" | "not-cached"
  | "waiting-network" | "waiting-wifi" | "paused" | "storage-full" | "failed";
export interface AudioDownload {
  path: string;
  hash: string;
  marksHash: string;
  bytes: number;
}
export const AUDIO_PRELOAD_KEY = "lv.offline.audioPreload";

export function audioPreloadStrategy(): AudioPreloadStrategy {
  const value = globalThis.localStorage?.getItem(AUDIO_PRELOAD_KEY);
  return value === "ahead" || value === "off" ? value : "book";
}

export function setAudioPreloadStrategy(value: AudioPreloadStrategy): void {
  globalThis.localStorage?.setItem(AUDIO_PRELOAD_KEY, value);
  globalThis.dispatchEvent(new Event("lv-download-policy"));
}

/** Keep unavailable chapters in the spine: lookahead means chapters, not files. */
export function audioPreloadOrder(paths: readonly string[], focus: string | null, strategy: AudioPreloadStrategy): string[] {
  if (strategy === "off" || paths.length === 0) return [];
  const at = Math.max(0, paths.indexOf(focus ?? ""));
  const near = paths.slice(at, at + 3);
  if (strategy === "ahead") return near;
  return [...new Set([...near, ...paths.slice(Math.max(0, at - 1), at),
    ...paths.slice(at + 3), ...paths.slice(0, Math.max(0, at - 1)).reverse()])];
}

export interface AudioDownloadEnvironment {
  blocked: "waiting-network" | "waiting-wifi" | "paused" | null;
  capBytes: number;
}

export interface AudioDownloadDeps {
  inspect(job: AudioDownload): Promise<{ ready: boolean; bytesToDownload: number }>;
  usedBytes(): Promise<number>;
  download(job: AudioDownload): Promise<void>;
  changed(): void;
  wake?(): void;
  now(): number;
  yield(): Promise<void>;
}

/** Two transfers, bounded inspection, one planner. Payloads stay in the host or
 * worker. A navigation change only reorders work not yet handed to that host. */
export class AudioPreloader {
  readonly states = new Map<string, AudioCacheState>();
  private inspected = new Set<string>();
  private active = new Map<string, AudioDownload>();
  private reservations = new Map<string, number>();
  private failures = new Map<string, { count: number; retryAt: number }>();
  private jobs: AudioDownload[] = [];
  private order: string[] = [];
  private environment: AudioDownloadEnvironment = { blocked: "paused", capBytes: 0 };
  private running: Promise<void> | undefined;
  private revision = 0;
  private disposed = false;
  constructor(private deps: AudioDownloadDeps) {}

  configure(jobs: AudioDownload[], order: string[], environment: AudioDownloadEnvironment): void {
    const previous = new Map(this.jobs.map(job => [job.hash, job]));
    const keep = new Set(jobs.map(job => job.hash));
    for (const hash of this.states.keys()) {
      if (!keep.has(hash) && !this.active.has(hash)) {
        this.states.delete(hash);
        this.inspected.delete(hash);
        this.failures.delete(hash);
        this.reservations.delete(hash);
      }
    }
    for (const job of jobs) {
      if (previous.get(job.hash)?.marksHash !== job.marksHash ||
        (!this.active.has(job.hash) && previous.get(job.hash)?.bytes !== job.bytes)) {
        this.inspected.delete(job.hash);
        this.states.set(job.hash, "checking");
      }
    }
    this.jobs = jobs;
    this.order = order;
    this.environment = environment;
    this.revision++;
  }

  /** Effect cleanup must stop scheduling without discarding verified identities
   * or retry deadlines when navigation immediately installs the next plan. */
  pause(): void {
    this.environment = { ...this.environment, blocked: "paused" };
    this.revision++;
  }

  /** Foreground/cache eviction revalidates the payload, not just a stale IDB bit. */
  invalidate(): void {
    this.inspected.clear();
    for (const [hash, state] of this.states) if (state === "cached") this.states.set(hash, "checking");
  }

  invalidateHash(hash: string): void {
    if (!this.states.has(hash) || this.active.has(hash)) return;
    this.inspected.delete(hash);
    this.states.set(hash, "checking");
    this.deps.wake?.();
  }

  nextWakeDelay(): number | null {
    const now = this.deps.now();
    if (this.jobs.some(job => !this.inspected.has(job.hash) && !this.active.has(job.hash) &&
      (this.failures.get(job.hash)?.retryAt ?? 0) <= now)) return 50;
    const wanted = new Set(this.order);
    const canDownload = !this.environment.blocked && this.active.size < 2;
    if (canDownload && this.jobs.some(job => wanted.has(job.path) && !this.active.has(job.hash) &&
      (this.states.get(job.hash) === "queued" || this.states.get(job.hash) === "not-cached"))) return 50;
    const retries = this.jobs.flatMap(job => {
      const failed = this.failures.get(job.hash);
      return failed && !this.active.has(job.hash) &&
        (!this.inspected.has(job.hash) || (canDownload && wanted.has(job.path)))
        ? [Math.max(50, failed.retryAt - now)] : [];
    });
    return retries.length > 0 ? Math.min(...retries) : null;
  }

  retry(): void { this.failures.clear(); }
  dispose(): void { this.disposed = true; }

  tick(): Promise<void> {
    this.running ??= this.run().finally(() => { this.running = undefined; });
    return this.running;
  }

  private fail(hash: string): void {
    const count = (this.failures.get(hash)?.count ?? 0) + 1;
    this.failures.set(hash, {
      count, retryAt: this.deps.now() + Math.min(5000 * 2 ** (count - 1), 300_000),
    });
    this.states.set(hash, "failed");
  }

  private async run(): Promise<void> {
    if (this.disposed) return;
    const revision = this.revision;
    const current = (): boolean => !this.disposed && revision === this.revision;
    // Check no more than 32 payloads per pass, even for very large books.
    let checked = 0;
    const jobs = new Map(this.jobs.map(job => [job.path, job]));
    const inspection = [...new Set([...this.order, ...jobs.keys()])];
    for (const path of inspection) {
      const job = jobs.get(path);
      if (!job) continue;
      if (!current()) return;
      if (this.active.has(job.hash) || this.inspected.has(job.hash)) continue;
      if ((this.failures.get(job.hash)?.retryAt ?? 0) > this.deps.now()) continue;
      try {
        const cached = await this.deps.inspect(job);
        if (!current()) return;
        this.inspected.add(job.hash);
        this.failures.delete(job.hash);
        this.reservations.set(job.hash, cached.bytesToDownload);
        this.states.set(job.hash, cached.ready ? "cached" : "not-cached");
      } catch {
        if (!current()) return;
        this.fail(job.hash);
      }
      if (++checked >= 32) break;
      await this.deps.yield();
    }
    if (!current()) return;
    const wanted = new Set(this.order);
    for (const job of this.jobs) {
      if (this.states.get(job.hash) === "cached" || !this.inspected.has(job.hash)) continue;
      this.states.set(job.hash, this.environment.blocked ??
        (this.active.has(job.hash) ? "downloading"
          : (this.failures.get(job.hash)?.retryAt ?? 0) > this.deps.now() ? "failed"
          : wanted.has(job.path) ? "queued" : "not-cached"));
    }
    const candidates = this.order.flatMap(path => {
      const job = jobs.get(path);
      return job && this.inspected.has(job.hash) && this.states.get(job.hash) !== "cached" &&
        !this.active.has(job.hash) && (this.failures.get(job.hash)?.retryAt ?? 0) <= this.deps.now() ? [job] : [];
    });
    if (this.environment.blocked || this.active.size >= 2 || candidates.length === 0) {
      this.deps.changed();
      return;
    }
    // Snapshot reservations before the async aggregate read. A transfer may
    // commit and leave active while that read still contains the older total.
    const pendingBytes = [...this.active.keys()].reduce((sum, hash) => sum + (this.reservations.get(hash) ?? 0), 0);
    let used: number;
    try {
      used = await this.deps.usedBytes();
      if (!Number.isFinite(used) || used < 0) throw new Error("Unknown cache usage");
    } catch {
      if (!current()) return;
      for (const job of candidates) this.fail(job.hash);
      this.deps.changed();
      return;
    }
    let reserved = pendingBytes + used;
    if (!current()) return;
    for (const job of candidates) {
      if (this.active.has(job.hash) || this.states.get(job.hash) === "cached") continue;
      const bytes = this.reservations.get(job.hash) ?? job.bytes;
      if (!Number.isFinite(bytes) || bytes < 0) {
        this.failures.set(job.hash, { count: 1, retryAt: this.deps.now() + 30_000 });
        this.states.set(job.hash, "failed");
        continue;
      }
      if (reserved + bytes > this.environment.capBytes) {
        this.states.set(job.hash, "storage-full");
        continue;
      }
      if (this.active.size >= 2) continue;
      reserved += bytes;
      this.active.set(job.hash, job);
      this.states.set(job.hash, "downloading");
      void this.deps.download(job).then(() => {
        this.failures.delete(job.hash);
        if (this.jobs.some(next => next.hash === job.hash && next.marksHash !== job.marksHash)) {
          this.inspected.delete(job.hash);
          this.states.set(job.hash, "checking");
        } else {
          this.states.set(job.hash, "cached");
        }
      }, () => this.fail(job.hash)).finally(() => {
        this.active.delete(job.hash);
        if (!this.disposed) {
          this.deps.changed();
          this.deps.wake?.();
        }
      });
    }
    if (!this.disposed) this.deps.changed();
  }
}
