/**
 * Merge rendered template frontmatter into an existing source note.
 *
 * A template key prefixed with `??` supplies a default: the prefix is removed
 * and the value is written only when the existing note does not already have
 * that key. Bare keys keep the historical overwrite-on-render behaviour.
 */
export function mergeTemplateFrontmatter(
    original: Record<string, unknown>,
    renderedTemplate: Record<string, unknown>,
): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...original };

    for (const [rawKey, value] of Object.entries(renderedTemplate)) {
        const preserveExisting = rawKey.startsWith("??");
        const key = preserveExisting ? rawKey.slice(2) : rawKey;
        if (!key) continue;

        if (!preserveExisting || !(key in merged)) {
            merged[key] = value;
        }
    }

    return merged;
}
