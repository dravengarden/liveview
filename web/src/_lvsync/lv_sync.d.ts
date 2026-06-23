/* tslint:disable */
/* eslint-disable */

/**
 * The handle the web app holds. `io` is `{ get, put, has, keys, remove, fetch }`
 * (all async); `manifestJson` is the corpus manifest.
 */
export class LvSync {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * GC orphans (hashes no longer in the manifest). Resolves to the count.
     */
    gc(): Promise<any>;
    constructor(io: any, manifest_json: string);
    /**
     * Byte-weighted offline fraction in [0,1].
     */
    offline_fraction(): Promise<any>;
    /**
     * Resolve a resource by logical path → its bytes (store-first, else fetch +
     * cache). Rejects with `"offline"` when uncached + unreachable.
     */
    resolve(path: string): Promise<any>;
    /**
     * Eager: pull the whole manifest into the store. Resolves to bytes cached.
     */
    sync_all(): Promise<any>;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_lvsync_free: (a: number, b: number) => void;
    readonly lvsync_gc: (a: number) => any;
    readonly lvsync_new: (a: any, b: number, c: number) => [number, number, number];
    readonly lvsync_offline_fraction: (a: number) => any;
    readonly lvsync_resolve: (a: number, b: number, c: number) => any;
    readonly lvsync_sync_all: (a: number) => any;
    readonly wasm_bindgen__convert__closures_____invoke__h304b2462919636c4: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h14b997ba5da0eecf: (a: number, b: number, c: any, d: any) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
