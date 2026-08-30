export interface ChapterFetchOptions {
  readonly cacheFirst?: boolean;
  readonly connectMs?: number;
}

export type ChapterFetcher = (
  url: string,
  opts?: ChapterFetchOptions,
) => Promise<Response>;

const TRANSIENT_RETRY_MS = 120;
const TRANSIENT_RETRY_BUDGET_MS = 5_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function transientStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/**
 * Fetch a reader chapter with one bounded recovery attempt.
 *
 * A chapter switch can race a foreground manifest refresh or a brief tunnel
 * interruption. The replica reports those misses as 504. Retry once from the
 * newly populated cache before replacing a valid page with an error screen.
 * Real 4xx responses and known-offline misses remain immediate.
 */
export async function fetchChapterResponse(
  url: string,
  fetcher: ChapterFetcher,
  isOffline: () => boolean,
  delay: (ms: number) => Promise<void> = wait,
): Promise<Response> {
  let first: Response;
  try {
    first = await fetcher(url);
  } catch (error) {
    if (isOffline()) throw error;
    await delay(TRANSIENT_RETRY_MS);
    return fetcher(url, {
      cacheFirst: true,
      connectMs: TRANSIENT_RETRY_BUDGET_MS,
    });
  }

  if (!transientStatus(first.status) || isOffline()) return first;
  await delay(TRANSIENT_RETRY_MS);
  return fetcher(url, {
    cacheFirst: true,
    connectMs: TRANSIENT_RETRY_BUDGET_MS,
  });
}
