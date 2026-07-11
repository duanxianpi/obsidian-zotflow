import React, { useCallback, useEffect, useState } from "react";
import { workerBridge } from "bridge";
import { services } from "services/services";
import { ObsidianIcon } from "ui/ObsidianIcon";

import type {
    Availability,
    LocaleInfo,
    StyleIndexEntry,
    StyleInfo,
} from "worker/csl";

type BadgeKind = "ready" | "resolvable" | "unavailable";

function badgeFor(a: Availability): { kind: BadgeKind; label: string } {
    switch (a.status) {
        case "ready":
            return { kind: "ready", label: "Ready" };
        case "resolvable":
            return { kind: "resolvable", label: "Resolvable" };
        case "unresolved-parent":
            return { kind: "unavailable", label: `Missing parent: ${a.parent}` };
        case "unresolved-locale":
            return { kind: "unavailable", label: `Missing locale: ${a.locale}` };
        case "missing":
            return { kind: "unavailable", label: "Missing" };
        case "invalid":
            return { kind: "unavailable", label: "Invalid" };
    }
}

function availabilityTooltip(a: Availability): string | undefined {
    return a.status === "invalid" ? a.reason : undefined;
}

const Badge: React.FC<{ availability: Availability }> = ({ availability }) => {
    const badge = badgeFor(availability);
    return (
        <span
            className={`zotflow-csl-badge zotflow-csl-badge-${badge.kind}`}
            title={availabilityTooltip(availability)}
        >
            {badge.label}
        </span>
    );
};

/** CSL tab: manage citation styles and locales for the CSL renderer. */
export const CslStylesView: React.FC = () => {
    const [styles, setStyles] = useState<StyleInfo[]>([]);
    const [locales, setLocales] = useState<LocaleInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);

    // "Add style" panel state
    const [showAddStyle, setShowAddStyle] = useState(false);
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<StyleIndexEntry[]>([]);
    const [searching, setSearching] = useState(false);
    const [pasteKey, setPasteKey] = useState("");
    const [pasteXml, setPasteXml] = useState("");

    // "Add locale" panel state
    const [showAddLocale, setShowAddLocale] = useState(false);
    const [localeTag, setLocaleTag] = useState("");

    const refresh = useCallback(async () => {
        try {
            const [styleList, localeList] = await Promise.all([
                workerBridge.cslRender.listStyles(),
                workerBridge.cslRender.listLocales(),
            ]);
            setStyles(styleList);
            setLocales(localeList);
        } catch (e) {
            services.logService.error(
                "Failed to load CSL styles/locales",
                "CslStylesView",
                e,
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // Debounced directory search
    useEffect(() => {
        if (!showAddStyle || query.trim().length < 2) {
            setResults([]);
            return;
        }
        let cancelled = false;
        setSearching(true);
        const timer = window.setTimeout(() => {
            void (async () => {
                try {
                    const hits = await workerBridge.cslRender.searchStyleIndex(
                        query.trim(),
                        20,
                    );
                    if (!cancelled) setResults(hits);
                } catch {
                    if (!cancelled) setResults([]);
                } finally {
                    if (!cancelled) setSearching(false);
                }
            })();
        }, 300);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [query, showAddStyle]);

    const handleDownloadStyle = useCallback(
        async (id: string) => {
            setBusy(true);
            try {
                const avail = await workerBridge.cslRender.ensureStyle(id);
                if (avail.status === "ready") {
                    services.notificationService.notify(
                        "success",
                        `Style "${id}" downloaded`,
                    );
                } else {
                    services.notificationService.notify(
                        "warning",
                        `Style "${id}" added, but not ready yet`,
                    );
                }
                await refresh();
            } catch (e) {
                services.logService.error(
                    `Failed to download style ${id}`,
                    "CslStylesView",
                    e,
                );
                services.notificationService.notify(
                    "error",
                    `Failed to download style "${id}".`,
                );
            } finally {
                setBusy(false);
            }
        },
        [refresh],
    );

    const handleResolveDeps = useCallback(
        async (id: string) => {
            setBusy(true);
            try {
                const avail = await workerBridge.cslRender.resolveDeps(id);
                services.notificationService.notify(
                    avail.status === "ready" ? "success" : "warning",
                    avail.status === "ready"
                        ? `"${id}" is ready`
                        : `"${id}" still has unresolved dependencies`,
                );
                await refresh();
            } finally {
                setBusy(false);
            }
        },
        [refresh],
    );

    const handleRemoveStyle = useCallback(
        async (style: StyleInfo) => {
            setBusy(true);
            try {
                await workerBridge.cslRender.removeStyle(style.id);
                services.notificationService.notify(
                    "success",
                    `Removed style "${style.id}"`,
                );
                await refresh();
            } catch (e) {
                services.logService.error(
                    `Failed to remove style ${style.id}`,
                    "CslStylesView",
                    e,
                );
                services.notificationService.notify(
                    "error",
                    `Could not remove "${style.id}".`,
                );
            } finally {
                setBusy(false);
            }
        },
        [refresh],
    );

    const handleAddPasted = useCallback(async () => {
        if (!pasteKey.trim() || !pasteXml.trim()) {
            services.notificationService.notify(
                "warning",
                "Provide both a style key and the style XML.",
            );
            return;
        }
        setBusy(true);
        try {
            const avail = await workerBridge.cslRender.registerCustomStyle(
                pasteKey.trim(),
                pasteXml,
                "paste",
            );
            services.notificationService.notify(
                avail.status === "ready" ? "success" : "warning",
                avail.status === "ready"
                    ? `Style "${pasteKey.trim()}" added`
                    : `Style "${pasteKey.trim()}" added, but not ready`,
            );
            setPasteKey("");
            setPasteXml("");
            await refresh();
        } finally {
            setBusy(false);
        }
    }, [pasteKey, pasteXml, refresh]);

    const handleAddLocale = useCallback(async () => {
        const tag = localeTag.trim();
        if (!tag) return;
        setBusy(true);
        try {
            const ok = await workerBridge.cslRender.ensureLocale(tag);
            if (ok) {
                services.notificationService.notify(
                    "success",
                    `Locale "${tag}" downloaded`,
                );
                setLocaleTag("");
            } else {
                services.notificationService.notify(
                    "error",
                    `Locale "${tag}" could not be downloaded.`,
                );
            }
            await refresh();
        } finally {
            setBusy(false);
        }
    }, [localeTag, refresh]);

    const handleRemoveLocale = useCallback(
        async (tag: string) => {
            setBusy(true);
            try {
                await workerBridge.cslRender.removeLocale(tag);
                await refresh();
            } finally {
                setBusy(false);
            }
        },
        [refresh],
    );

    const localIds = new Set(styles.map((s) => s.id));
    const freshResults = results.filter((r) => !localIds.has(r.name));

    return (
        <div className="zotflow-csl-view">
            {/* ── Styles ── */}
            <div className="zotflow-csl-section-header">
                <span>Styles</span>
                <button
                    className="clickable-icon"
                    aria-label="Add style"
                    onClick={() => setShowAddStyle((v) => !v)}
                >
                    <ObsidianIcon icon={showAddStyle ? "x" : "plus"} />
                </button>
            </div>

            {showAddStyle && (
                <div className="zotflow-csl-add-panel">
                    <input
                        type="text"
                        placeholder="Search the style directory (e.g. nature, ieee)…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                    {searching && (
                        <div className="zotflow-csl-muted">Searching…</div>
                    )}
                    {freshResults.length > 0 && (
                        <div className="zotflow-csl-list zotflow-csl-search-results">
                            {freshResults.map((r) => (
                                <div className="zotflow-csl-row" key={r.name}>
                                    <div className="zotflow-csl-row-info">
                                        <div className="zotflow-csl-row-title">
                                            {r.title}
                                        </div>
                                        <div className="zotflow-csl-row-meta">
                                            {r.name}
                                            {r.dependent ? " · dependent" : ""}
                                        </div>
                                    </div>
                                    <button
                                        className="mod-cta"
                                        disabled={busy}
                                        onClick={() =>
                                            void handleDownloadStyle(r.name)
                                        }
                                    >
                                        Download
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                    <details className="zotflow-csl-paste">
                        <summary>Or paste style XML</summary>
                        <input
                            type="text"
                            placeholder="Style key (e.g. my-style)"
                            value={pasteKey}
                            onChange={(e) => setPasteKey(e.target.value)}
                        />
                        <textarea
                            rows={5}
                            placeholder="<style …>"
                            value={pasteXml}
                            onChange={(e) => setPasteXml(e.target.value)}
                        />
                        <button disabled={busy} onClick={() => void handleAddPasted()}>
                            Add pasted style
                        </button>
                    </details>
                </div>
            )}

            <div className="zotflow-csl-list">
                {loading && <div className="zotflow-csl-muted">Loading…</div>}
                {!loading && styles.length === 0 && (
                    <div className="zotflow-csl-muted">
                        No styles yet — click + to search and download one.
                    </div>
                )}
                {styles.map((style) => (
                    <div className="zotflow-csl-row" key={style.id}>
                        <div className="zotflow-csl-row-info">
                            <div className="zotflow-csl-row-title">
                                {style.title ?? style.id}
                            </div>
                            <div className="zotflow-csl-row-meta">
                                {[
                                    style.id,
                                    style.source,
                                    style.dependent && style.parent
                                        ? `parent: ${style.parent}`
                                        : null,
                                ]
                                    .filter(Boolean)
                                    .join(" · ")}
                            </div>
                        </div>
                        <Badge availability={style.availability} />
                        {style.availability.status === "resolvable" && (
                            <button
                                disabled={busy}
                                onClick={() => void handleResolveDeps(style.id)}
                            >
                                Download dependencies
                            </button>
                        )}
                        {style.source === "folder" ? (
                            <span
                                className="zotflow-csl-muted"
                                title="Folder styles are files in your vault — delete the file to remove"
                            >
                                folder
                            </span>
                        ) : (
                            <button
                                className="clickable-icon"
                                aria-label={`Remove ${style.id}`}
                                disabled={busy}
                                onClick={() => void handleRemoveStyle(style)}
                            >
                                <ObsidianIcon icon="trash-2" />
                            </button>
                        )}
                    </div>
                ))}
            </div>

            {/* ── Locales ── */}
            <div className="zotflow-csl-section-header">
                <span>Locales</span>
                <button
                    className="clickable-icon"
                    aria-label="Add locale"
                    onClick={() => setShowAddLocale((v) => !v)}
                >
                    <ObsidianIcon icon={showAddLocale ? "x" : "plus"} />
                </button>
            </div>

            {showAddLocale && (
                <div className="zotflow-csl-add-panel zotflow-csl-add-locale">
                    <input
                        type="text"
                        placeholder="Locale tag (e.g. de-DE, zh-CN, fr-FR)"
                        value={localeTag}
                        onChange={(e) => setLocaleTag(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") void handleAddLocale();
                        }}
                    />
                    <button
                        className="mod-cta"
                        disabled={busy || !localeTag.trim()}
                        onClick={() => void handleAddLocale()}
                    >
                        Download
                    </button>
                </div>
            )}

            <div className="zotflow-csl-list">
                {locales.map((locale) => (
                    <div className="zotflow-csl-row" key={locale.tag}>
                        <div className="zotflow-csl-row-info">
                            <div className="zotflow-csl-row-title">
                                {locale.tag}
                            </div>
                            <div className="zotflow-csl-row-meta">
                                {locale.source === "builtin"
                                    ? "bundled"
                                    : locale.source === "folder"
                                      ? "from styles folder"
                                      : "downloaded"}
                            </div>
                        </div>
                        {locale.source === "remote-cache" ? (
                            <button
                                className="clickable-icon"
                                aria-label={`Remove ${locale.tag}`}
                                disabled={busy}
                                onClick={() =>
                                    void handleRemoveLocale(locale.tag)
                                }
                            >
                                <ObsidianIcon icon="trash-2" />
                            </button>
                        ) : (
                            <span className="zotflow-csl-muted">
                                {locale.source === "builtin"
                                    ? "always available"
                                    : "folder"}
                            </span>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
};
