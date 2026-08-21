// In-memory IndexedDB used by Deno tests. Deno has no IDB, and this is not
// the production blob engine.

type Key = IDBValidKey;

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  if (value instanceof ArrayBuffer) return value.slice(0) as T;
  return JSON.parse(JSON.stringify(value)) as T;
}

function readPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function keyFromPath(value: unknown, keyPath: string | string[]): Key {
  if (Array.isArray(keyPath)) {
    return keyPath.map((p) => keyFromPath(value, p)) as Key[];
  }
  return readPath(value, keyPath) as Key;
}

export function compareKeys(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = compareKeys(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return 0;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function encodeKey(key: Key): string {
  return JSON.stringify(key);
}

export class MemoryKeyRange {
  readonly lower: Key | undefined;
  readonly upper: Key | undefined;
  readonly lowerOpen: boolean;
  readonly upperOpen: boolean;

  constructor(
    lower: Key | undefined,
    upper: Key | undefined,
    lowerOpen: boolean,
    upperOpen: boolean,
  ) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = lowerOpen;
    this.upperOpen = upperOpen;
  }

  static bound(
    lower: Key,
    upper: Key,
    lowerOpen = false,
    upperOpen = false,
  ): MemoryKeyRange {
    return new MemoryKeyRange(lower, upper, lowerOpen, upperOpen);
  }

  static only(key: Key): MemoryKeyRange {
    return new MemoryKeyRange(key, key, false, false);
  }

  static lowerBound(lower: Key, open = false): MemoryKeyRange {
    return new MemoryKeyRange(lower, undefined, open, false);
  }

  static upperBound(upper: Key, open = false): MemoryKeyRange {
    return new MemoryKeyRange(undefined, upper, false, open);
  }

  includes(key: Key): boolean {
    if (this.lower !== undefined) {
      const c = compareKeys(key, this.lower);
      if (c < 0 || (c === 0 && this.lowerOpen)) return false;
    }
    if (this.upper !== undefined) {
      const c = compareKeys(key, this.upper);
      if (c > 0 || (c === 0 && this.upperOpen)) return false;
    }
    return true;
  }
}

class Emitter {
  onsuccess: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  oncomplete: ((ev: Event) => void) | null = null;
  onabort: ((ev: Event) => void) | null = null;
  onupgradeneeded: ((ev: Event) => void) | null = null;
  onversionchange: ((ev: Event) => void) | null = null;
  private readonly listeners = new Map<string, Set<(ev: Event) => void>>();

  addEventListener(type: string, fn: EventListenerOrEventListenerObject): void {
    if (typeof fn !== "function") return;
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(
    type: string,
    fn: EventListenerOrEventListenerObject,
  ): void {
    if (typeof fn !== "function") return;
    this.listeners.get(type)?.delete(fn);
  }

  dispatch(type: string): void {
    const ev = { type, target: this } as unknown as Event;
    const prop = (this as unknown as Record<string, unknown>)[`on${type}`];
    if (typeof prop === "function") {
      (prop as (e: Event) => void).call(this, ev);
    }
    for (const fn of this.listeners.get(type) ?? []) fn.call(this, ev);
  }
}

class MemoryRequest<T> extends Emitter {
  result!: T;
  error: DOMException | Error | null = null;
  readyState: "pending" | "done" = "pending";
  source: unknown = null;
  transaction: MemoryTransaction | null = null;
}

function quotaError(): Error {
  const err = new Error("The quota has been exceeded.") as Error & {
    name: string;
  };
  err.name = "QuotaExceededError";
  return err;
}

function schedule(fn: () => void): void {
  queueMicrotask(fn);
}

class MemoryStringList {
  constructor(private readonly items: string[]) {}
  contains(name: string): boolean {
    return this.items.includes(name);
  }
  item(index: number): string | null {
    return this.items[index] ?? null;
  }
  get length(): number {
    return this.items.length;
  }
  [Symbol.iterator](): IterableIterator<string> {
    return this.items[Symbol.iterator]();
  }
}

interface StoredRow {
  key: Key;
  value: unknown;
}

class MemoryIndex {
  constructor(
    readonly name: string,
    readonly keyPath: string | string[],
    private readonly store: MemoryObjectStore,
  ) {}

  openCursor(range?: MemoryKeyRange | IDBKeyRange | null): MemoryRequest<
    MemoryCursor | null
  > {
    return this.store.openIndexCursor(this, range ?? null);
  }

  get(key: Key): MemoryRequest<unknown> {
    const req = new MemoryRequest<unknown>();
    this.store.txn.addPending();
    schedule(() => {
      for (const row of this.store.rows()) {
        const ik = keyFromPath(row.value, this.keyPath);
        if (compareKeys(ik, key) === 0) {
          req.result = cloneValue(row.value);
          req.readyState = "done";
          req.dispatch("success");
          this.store.txn.removePending();
          return;
        }
      }
      req.result = undefined;
      req.readyState = "done";
      req.dispatch("success");
      this.store.txn.removePending();
    });
    return req;
  }
}

class MemoryCursor {
  constructor(
    private readonly rows: StoredRow[],
    private index: number,
    private readonly req: MemoryRequest<MemoryCursor | null>,
    private readonly store: MemoryObjectStore,
    private readonly indexKeyPath: string | string[] | null,
  ) {}

  get value(): unknown {
    return this.rows[this.index]?.value;
  }

  get key(): Key {
    const row = this.rows[this.index];
    if (!row) return "" as Key;
    return this.indexKeyPath
      ? keyFromPath(row.value, this.indexKeyPath)
      : row.key;
  }

  get primaryKey(): Key {
    return this.rows[this.index]?.key ?? ("" as Key);
  }

  continue(): void {
    this.index += 1;
    this.store.txn.addPending();
    schedule(() => {
      this.advance();
      this.store.txn.removePending();
    });
  }

  delete(): MemoryRequest<undefined> {
    const row = this.rows[this.index];
    const req = new MemoryRequest<undefined>();
    this.store.txn.addPending();
    schedule(() => {
      if (row) this.store.remove(row.key);
      req.result = undefined;
      req.readyState = "done";
      req.dispatch("success");
      this.store.txn.removePending();
    });
    return req;
  }

  advance(): void {
    if (this.index >= this.rows.length) {
      this.req.result = null;
      this.req.readyState = "done";
      this.req.dispatch("success");
      return;
    }
    this.req.result = this;
    this.req.readyState = "done";
    this.req.dispatch("success");
  }
}

class MemoryObjectStore {
  readonly indexes = new Map<string, MemoryIndex>();
  private readonly data = new Map<string, StoredRow>();

  constructor(
    readonly name: string,
    readonly keyPath: string | string[],
    readonly txn: MemoryTransaction,
    private readonly db: MemoryDatabase,
    shared?: Map<string, StoredRow>,
  ) {
    if (shared) this.data = shared;
  }

  rows(): StoredRow[] {
    return [...this.data.values()];
  }

  createIndex(
    name: string,
    keyPath: string | string[],
    _opts?: IDBIndexParameters,
  ): MemoryIndex {
    const idx = new MemoryIndex(name, keyPath, this);
    this.indexes.set(name, idx);
    this.db.rememberIndex(this.name, name, keyPath);
    return idx;
  }

  index(name: string): MemoryIndex {
    const idx = this.indexes.get(name);
    if (!idx) throw new Error(`index ${name} not found`);
    return idx;
  }

  put(value: unknown): MemoryRequest<Key> {
    const req = new MemoryRequest<Key>();
    this.txn.addPending();
    schedule(() => {
      try {
        const key = keyFromPath(value, this.keyPath);
        const cloned = cloneValue(value);
        this.db.checkQuota(this.name, this.data.get(encodeKey(key)), cloned);
        this.data.set(encodeKey(key), { key, value: cloned });
        req.result = key;
        req.readyState = "done";
        req.dispatch("success");
      } catch (error) {
        req.error = error as Error;
        req.readyState = "done";
        req.dispatch("error");
        this.txn.fail(error);
      }
      this.txn.removePending();
    });
    return req;
  }

  get(key: Key): MemoryRequest<unknown> {
    const req = new MemoryRequest<unknown>();
    this.txn.addPending();
    schedule(() => {
      const row = this.data.get(encodeKey(key));
      req.result = row ? cloneValue(row.value) : undefined;
      req.readyState = "done";
      req.dispatch("success");
      this.txn.removePending();
    });
    return req;
  }

  delete(key: Key): MemoryRequest<undefined> {
    const req = new MemoryRequest<undefined>();
    this.txn.addPending();
    schedule(() => {
      this.remove(key);
      req.result = undefined;
      req.readyState = "done";
      req.dispatch("success");
      this.txn.removePending();
    });
    return req;
  }

  clear(): MemoryRequest<undefined> {
    const req = new MemoryRequest<undefined>();
    this.txn.addPending();
    schedule(() => {
      this.data.clear();
      req.result = undefined;
      req.readyState = "done";
      req.dispatch("success");
      this.txn.removePending();
    });
    return req;
  }

  remove(key: Key): void {
    this.data.delete(encodeKey(key));
  }

  openCursor(range?: MemoryKeyRange | IDBKeyRange | null): MemoryRequest<
    MemoryCursor | null
  > {
    return this.openIndexCursor(null, range ?? null);
  }

  openIndexCursor(
    index: MemoryIndex | null,
    range: MemoryKeyRange | IDBKeyRange | null,
  ): MemoryRequest<MemoryCursor | null> {
    const req = new MemoryRequest<MemoryCursor | null>();
    this.txn.addPending();
    schedule(() => {
      const keyPath = index?.keyPath ?? null;
      const memRange = range as MemoryKeyRange | null;
      const rows = this.rows().filter((row) => {
        if (!memRange) return true;
        const k = keyPath ? keyFromPath(row.value, keyPath) : row.key;
        return memRange.includes(k);
      });
      rows.sort((a, b) => {
        const ka = keyPath ? keyFromPath(a.value, keyPath) : a.key;
        const kb = keyPath ? keyFromPath(b.value, keyPath) : b.key;
        const c = compareKeys(ka, kb);
        if (c !== 0) return c;
        return compareKeys(a.key, b.key);
      });
      const cursor = new MemoryCursor(rows, 0, req, this, keyPath);
      cursor.advance();
      this.txn.removePending();
    });
    return req;
  }
}

class MemoryTransaction extends Emitter {
  private pending = 0;
  private commitRequested = false;
  private finished = false;
  error: Error | null = null;
  readonly objectStoreNames: MemoryStringList;

  constructor(
    private readonly db: MemoryDatabase,
    names: string[],
    readonly mode: IDBTransactionMode,
  ) {
    super();
    this.objectStoreNames = new MemoryStringList(names);
  }

  objectStore(name: string): MemoryObjectStore {
    return this.db.storeForTxn(name, this);
  }

  addPending(): void {
    this.pending++;
  }

  removePending(): void {
    this.pending--;
    this.maybeFinish();
  }

  commit(): void {
    this.commitRequested = true;
    this.maybeFinish();
  }

  abort(): void {
    if (this.finished) return;
    this.finished = true;
    this.dispatch("abort");
  }

  fail(error: unknown): void {
    this.error = error as Error;
    if (!this.finished) {
      this.finished = true;
      this.dispatch("error");
      this.dispatch("abort");
    }
  }

  private maybeFinish(): void {
    if (this.finished || this.pending > 0) return;
    if (!this.commitRequested && this.mode === "readonly") {
      this.commitRequested = true;
    }
    if (!this.commitRequested) {
      schedule(() => {
        if (!this.finished && this.pending === 0) {
          this.commitRequested = true;
          this.maybeFinish();
        }
      });
      return;
    }
    this.finished = true;
    schedule(() => this.dispatch("complete"));
  }
}

class MemoryDatabase extends Emitter {
  readonly objectStores = new Map<string, Map<string, StoredRow>>();
  readonly indexMeta = new Map<string, Map<string, string | string[]>>();
  private readonly storeNames: string[] = [];

  constructor(
    readonly name: string,
    public version: number,
    readonly factory: MemoryFactory,
  ) {
    super();
  }

  get objectStoreNames(): MemoryStringList {
    return new MemoryStringList([...this.storeNames]);
  }

  createObjectStore(
    name: string,
    opts?: IDBObjectStoreParameters,
  ): MemoryObjectStore {
    if (!this.objectStores.has(name)) {
      this.objectStores.set(name, new Map());
      this.storeNames.push(name);
      this.indexMeta.set(name, new Map());
    }
    const dummy = new MemoryTransaction(this, [name], "versionchange");
    dummy.commit();
    const store = new MemoryObjectStore(
      name,
      (opts?.keyPath ?? "key") as string | string[],
      dummy,
      this,
      this.objectStores.get(name),
    );
    this.rememberKeyPath(name, store.keyPath);
    return store;
  }

  private keyPaths = new Map<string, string | string[]>();

  rememberKeyPath(name: string, keyPath: string | string[]): void {
    this.keyPaths.set(name, keyPath);
  }

  rememberIndex(
    store: string,
    name: string,
    keyPath: string | string[],
  ): void {
    let map = this.indexMeta.get(store);
    if (!map) {
      map = new Map();
      this.indexMeta.set(store, map);
    }
    map.set(name, keyPath);
  }

  storeForTxn(name: string, txn: MemoryTransaction): MemoryObjectStore {
    const data = this.objectStores.get(name);
    if (!data) throw new Error(`store ${name} not found`);
    const store = new MemoryObjectStore(
      name,
      this.keyPaths.get(name) ?? "key",
      txn,
      this,
      data,
    );
    for (const [idxName, keyPath] of this.indexMeta.get(name) ?? []) {
      store.indexes.set(idxName, new MemoryIndex(idxName, keyPath, store));
    }
    return store;
  }

  transaction(
    storeNames: string | string[],
    mode: IDBTransactionMode = "readonly",
  ): MemoryTransaction {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    return new MemoryTransaction(this, names, mode);
  }

  close(): void {
    // no-op: tests reopen via delete + open
  }

  checkQuota(storeName: string, oldRow: StoredRow | undefined, next: unknown): void {
    const quota = this.factory.quotaBytes;
    if (quota === null) return;
    const used = this.blobBytes();
    const oldBytes = storeName === "blobs" ? dataBytes(oldRow?.value) : 0;
    const newBytes = storeName === "blobs" ? dataBytes(next) : 0;
    if (used - oldBytes + newBytes > quota) throw quotaError();
  }

  private blobBytes(): number {
    const blobs = this.objectStores.get("blobs");
    if (!blobs) return 0;
    let n = 0;
    for (const row of blobs.values()) n += dataBytes(row.value);
    return n;
  }
}

function dataBytes(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const data = (value as { data?: unknown }).data;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return 0;
}

class MemoryOpenRequest extends MemoryRequest<MemoryDatabase> {
  // IDBOpenDBRequest
}

export class MemoryFactory extends Emitter {
  readonly dbs = new Map<string, MemoryDatabase>();
  quotaBytes: number | null = null;

  open(name: string, version?: number): MemoryOpenRequest {
    const req = new MemoryOpenRequest();
    schedule(() => {
      let db = this.dbs.get(name);
      const ver = version ?? (db?.version ?? 1);
      if (!db) {
        db = new MemoryDatabase(name, ver, this);
        this.dbs.set(name, db);
        req.result = db;
        req.dispatch("upgradeneeded");
        req.readyState = "done";
        req.dispatch("success");
        return;
      }
      if (ver < db.version) {
        req.error = new Error("VersionError");
        req.readyState = "done";
        req.dispatch("error");
        return;
      }
      if (ver > db.version) {
        db.version = ver;
        req.result = db;
        req.dispatch("upgradeneeded");
        req.readyState = "done";
        req.dispatch("success");
        return;
      }
      req.result = db;
      req.readyState = "done";
      req.dispatch("success");
    });
    return req;
  }

  deleteDatabase(name: string): MemoryOpenRequest {
    const req = new MemoryOpenRequest();
    schedule(() => {
      this.dbs.delete(name);
      req.readyState = "done";
      req.dispatch("success");
    });
    return req;
  }

  cmp(a: Key, b: Key): number {
    return compareKeys(a, b);
  }
}

export interface MemoryIdbHandle {
  factory: MemoryFactory;
  setQuotaBytes: (n: number | null) => void;
}

let installed: MemoryIdbHandle | null = null;

export function installMemoryIndexedDB(
  target: typeof globalThis = globalThis,
): MemoryIdbHandle {
  const factory = new MemoryFactory();
  const g = target as typeof globalThis & {
    indexedDB: IDBFactory;
    IDBKeyRange: typeof IDBKeyRange;
  };
  g.indexedDB = factory as unknown as IDBFactory;
  g.IDBKeyRange = MemoryKeyRange as unknown as typeof IDBKeyRange;
  const handle = {
    factory,
    setQuotaBytes: (n: number | null): void => {
      factory.quotaBytes = n;
    },
  };
  installed = handle;
  return handle;
}

export function memoryIdbHandle(): MemoryIdbHandle | null {
  return installed;
}
