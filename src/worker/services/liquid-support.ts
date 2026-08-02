import type { Liquid } from "liquidjs";

/**
 * Per-render values the template services stash on the Liquid environment for
 * their filters to read back. Both are optional because the citation and
 * preview render paths do not populate them.
 */
export interface ZfEnvironments {
    __zfZoteroLibPrefix?: string;
    __zfReadOnlyKeys?: Set<string>;
}

/**
 * LiquidJS's filter `this`, kept deliberately wide. Its own `FilterImpl` is
 * not exported from the package root, and `this` is contravariant — declaring
 * `environments` as `ZfEnvironments` here makes the handler unassignable to
 * `FilterHandler`, whose `environments` is the engine's broad `Scope`.
 */
export interface LiquidFilterScope {
    context?: { environments?: unknown };
}

/** Reads this render's stashed values off the filter scope. */
export function zfEnv(scope: LiquidFilterScope): ZfEnvironments {
    return scope?.context?.environments ?? {};
}

/** `Liquid.parseAndRender` is typed `any`; every template here renders text. */
export async function renderLiquid(
    engine: Liquid,
    template: string,
    scope: object,
): Promise<string> {
    return (await engine.parseAndRender(template, scope)) as string;
}
