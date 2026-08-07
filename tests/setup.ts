/**
 * Global test setup — runs once per test file, before any suite.
 *
 * Installs an in-memory IndexedDB so the `db` singleton in `db/db` opens for
 * real. Tests exercise the actual Dexie schema, compound indexes and version
 * upgrades rather than a hand-written stand-in.
 */
import "fake-indexeddb/auto";
import { setProxiedFetch } from "worker/proxied-fetch";

/**
 * Workaround for a fake-indexeddb deviation from the IndexedDB spec.
 *
 * "Convert a value to a key" detects cycles with a `seen` set. Per spec that
 * set is *copied* down each recursion level, so it only ever holds an entry's
 * ancestors — meaning a key array may legally contain the same array object
 * twice (`[x, x]`). fake-indexeddb mutates one shared set instead, so a
 * repeated reference looks like a cycle and throws DataError.
 *
 * This bites us because Dexie's virtual-index support pads key ranges with
 * `Dexie.maxKey` — a single shared `[[]]` object — once per missing key part.
 * Any query against a 2+-part prefix of a longer compound index (e.g.
 * `db.items.where({ libraryID, parentItem })` against
 * `[libraryID+parentItem+itemType+trashed]`) therefore fails here while
 * working correctly in a browser.
 *
 * Deep-cloning array keys at the IDBKeyRange/cursor boundary makes repeated
 * references distinct objects, which both engines then accept. Remove this
 * once fake-indexeddb scopes `seen` per the spec.
 */
function cloneArrayKeys<T>(key: T): T {
    return (Array.isArray(key) ? key.map(cloneArrayKeys) : key) as T;
}

for (const method of ["only", "lowerBound", "upperBound", "bound"] as const) {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- reapplied via .apply below
    const original = IDBKeyRange[method] as (...args: unknown[]) => IDBKeyRange;
    (IDBKeyRange as unknown as Record<string, unknown>)[method] = function (
        ...args: unknown[]
    ) {
        // Booleans (`lowerOpen`/`upperOpen`) pass through untouched.
        return original.apply(IDBKeyRange, args.map(cloneArrayKeys));
    };
}

// eslint-disable-next-line @typescript-eslint/unbound-method -- reapplied via .call below
const originalContinue = IDBCursor.prototype.continue;
IDBCursor.prototype.continue = function (key?: IDBValidKey) {
    return originalContinue.call(this, cloneArrayKeys(key));
};

/**
 * Worker code assumes a browser-ish global. Node exposes `navigator` but
 * without `onLine`, which `SyncService.startSync` reads as its offline guard —
 * leaving it undefined makes every sync throw NETWORK_ERROR. Default to
 * online; a test wanting the offline path can override with
 * `vi.stubGlobal("navigator", { onLine: false })`.
 */
if (!("onLine" in globalThis.navigator)) {
    Object.defineProperty(globalThis.navigator, "onLine", {
        value: true,
        configurable: true,
        writable: true,
    });
}

/**
 * Main-thread code schedules timers as `window.setTimeout` rather than the
 * bare global, so that a timer started for a popout window is cancellable from
 * it (`obsidianmd/prefer-window-timers`). Node has no `window`; pointing it at
 * the global object is what a browser already does, and it keeps
 * `vi.useFakeTimers()` — which patches the global — in effect.
 */
if (!("window" in globalThis)) {
    Object.defineProperty(globalThis, "window", {
        value: globalThis,
        configurable: true,
        writable: true,
    });
}

setProxiedFetch((url, init) => fetch(url, init));
