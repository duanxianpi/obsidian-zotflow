import { services } from "services/services";

/**
 * Builds a reporter for async work the caller does not wait on, so a rejection
 * is logged rather than dropped. The log context is bound once per module:
 *
 * ```ts
 * const ff = fireAndForgetIn("ZoteroReaderView");
 * ff(this.loadDocument(), "Failed to load document");
 * ```
 *
 * Use it where the work is an action whose failure would otherwise leave the
 * interface silently wrong. Where a rejection genuinely does not matter, `void`
 * is the more accurate statement — this is not a blanket substitute for it.
 *
 * `services` is read inside the call, not at module load, so importing this
 * from a module that `services` itself reaches is safe.
 */
export function fireAndForgetIn(
    context: string,
): (work: Promise<unknown>, what: string) => void {
    return (work, what) =>
        void work.catch((e) => services.logService.error(what, context, e));
}
