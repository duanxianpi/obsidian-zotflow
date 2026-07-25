/**
 * Barrel re-exports for the worker/convert module.
 *
 * Conversion functions are accessed via ConvertService (worker/services/convert).
 * This barrel only re-exports types and low-level internals needed by the service.
 */

export { html2mdWithProcessors } from "./html-to-md";
export type { Html2MdOptions } from "./html-to-md";
export { md2htmlWithProcessors } from "./md-to-html";
export type { ConvertOptions } from "./md-to-html";
export { annoHtml2md, annoMd2html } from "./annotation-comment";
