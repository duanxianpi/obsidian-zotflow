/**
 * Stub for the `obsidian` module.
 *
 * The worker layer under test imports Obsidian only for types, which erase at
 * compile time. This exists so that any transitive runtime import resolves to
 * something inert instead of failing to resolve — and fails loudly if a test
 * ever actually depends on Obsidian behaviour.
 */

function notAvailable(name: string): never {
    throw new Error(
        `obsidian.${name} was called in a test. The module under test reaches ` +
            `into the Obsidian runtime — inject a fake instead of relying on this stub.`,
    );
}

export class Notice {
    constructor() {
        notAvailable("Notice");
    }
}

export function requestUrl(): never {
    return notAvailable("requestUrl");
}

export function normalizePath(path: string): string {
    return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export const Platform = {
    isDesktopApp: false,
    isMobileApp: false,
    isAndroidApp: false,
};
