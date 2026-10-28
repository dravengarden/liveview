/** The newest `/api/settings` value this client knows the server holds, per key.
 *
 *  Startup adoption re-`set()`s each mirrored store with the value it just read
 *  from the server, before the store's own async `connect()` has adopted it, so
 *  the write looks like an edit. Pushing it back is not harmless: settings are
 *  last-write-wins by `ts`, so the echo re-stamps old playback state as newest
 *  and can overwrite a fresher write from another device. A PUT whose value the
 *  server already holds is therefore dropped.
 *
 *  Our own writes and every server push update the record, so changing a value
 *  and then changing it back still sends the second write. */
export class KnownSettings {
  #values = new Map<string, string>();

  /** Fill from the bulk GET. A value already noted from a write or push that
   *  raced ahead of the GET is newer and is kept. */
  seed(map: Record<string, string>): void {
    for (const [key, value] of Object.entries(map)) {
      if (!this.#values.has(key)) this.#values.set(key, value);
    }
  }

  /** Record a value we sent or the server pushed. */
  note(key: string, value: string): void {
    this.#values.set(key, value);
  }

  /** Whether writing `value` would only repeat what the server holds. */
  isEcho(key: string, value: string): boolean {
    return this.#values.get(key) === value;
  }
}
