/**
 * Small typed readers for hast element properties.
 *
 * hast stores `properties` loosely — `className` arrives parsed into an array
 * or missing entirely, `style` as a string or missing. These keep the
 * narrowing in one place instead of at every call site.
 */

import type { Element } from "hast";

/** `className` as a string array. Empty when the attribute is absent. */
export function classNames(node: Element): string[] {
    const raw = node.properties.className;
    return Array.isArray(raw) ? raw.map(String) : [];
}

/** Whether the element carries a given class. */
export function hasClass(node: Element, name: string): boolean {
    return classNames(node).includes(name);
}

/** Inline `style` as a string. Empty when the attribute is absent. */
export function styleStr(node: Element): string {
    const raw = node.properties.style;
    return typeof raw === "string" ? raw : "";
}
