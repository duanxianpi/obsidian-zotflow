import React from "react";
import { ObsidianIcon } from "ui/ObsidianIcon";
import { fmtRelativeTime } from "ui/modals/csl-style-details";

import type { Availability, LocaleInfo, StyleInfo } from "worker/csl";

/* ---------------------------------------------------------------- */
/*  Row-state helpers                                                */
/* ---------------------------------------------------------------- */

export type RowState = "ready" | "resolvable" | "unavailable";

export function rowState(a: Availability): RowState {
    switch (a.status) {
        case "ready":
            return "ready";
        case "resolvable":
            return "resolvable";
        default:
            return "unavailable";
    }
}

export function unavailableReason(a: Availability): string | undefined {
    switch (a.status) {
        case "invalid":
            return `Invalid CSL — ${a.reason}`;
        case "unresolved-parent":
            return `Parent style "${a.parent}" could not be downloaded.`;
        case "unresolved-locale":
            return `Locale "${a.locale}" could not be downloaded.`;
        case "missing":
            return "Style file is missing.";
        default:
            return undefined;
    }
}

/** Effective (own or parent-inherited) format + bibliography capability. */
export function effectiveCaps(
    style: StyleInfo,
    byId: Map<string, StyleInfo>,
): { format?: string; inherited: boolean; hasBib?: boolean } {
    if (!style.dependent) {
        return {
            format: style.citationFormat,
            inherited: false,
            hasBib: style.hasBibliography,
        };
    }
    const parent = style.parent ? byId.get(style.parent) : undefined;
    return {
        format: style.citationFormat ?? parent?.citationFormat,
        inherited: !style.citationFormat && !!parent?.citationFormat,
        hasBib: parent?.hasBibliography,
    };
}

/* ---------------------------------------------------------------- */
/*  Primitives                                                       */
/* ---------------------------------------------------------------- */

/** Quiet leading status: pale dot on the happy path, escalate on problems. */
export const LeadingStatus: React.FC<{ state: RowState }> = ({ state }) => {
    if (state === "unavailable") {
        return (
            <ObsidianIcon
                icon="alert-triangle"
                className="zotflow-csl-status-icon"
            />
        );
    }
    return <span className={`zotflow-csl-dot zotflow-csl-dot--${state}`} />;
};

export const FormatBadge: React.FC<{
    format?: string;
    inherited?: boolean;
}> = ({ format, inherited }) => (
    <span
        className={`zotflow-csl-fbadge${format ? "" : " zotflow-csl-fbadge--pending"}`}
        title={
            format && inherited
                ? "Format inherited from parent style"
                : undefined
        }
    >
        {format ?? "pending"}
        {format && inherited ? " ↖" : ""}
    </span>
);

/**
 * Output capability badges: "citation" whenever the capabilities are known
 * (every usable style cites), "bib" only when the style declares a
 * bibliography — a note-only style reads as citation-without-bib. Unknown
 * (alias whose parent is missing) renders nothing.
 */
export const OutputBadges: React.FC<{ hasBib?: boolean }> = ({ hasBib }) => {
    if (hasBib === undefined) return null;
    return (
        <>
            <span
                className="zotflow-csl-fbadge"
                title="Produces in-text/footnote citations"
            >
                citation
            </span>
            {hasBib && (
                <span
                    className="zotflow-csl-fbadge"
                    title="Produces a bibliography (reference list)"
                >
                    bib
                </span>
            )}
        </>
    );
};

/* ---------------------------------------------------------------- */
/*  Section header                                                   */
/* ---------------------------------------------------------------- */

export const SectionHeader: React.FC<{
    label: string;
    count: number;
    checkedAt?: number;
    busy: boolean;
    onUpdateAll?: () => void;
    onAdd: () => void;
}> = ({ label, count, checkedAt, busy, onUpdateAll, onAdd }) => (
    <div className="zotflow-csl-section-header">
        <span className="zotflow-csl-section-title">{label}</span>
        <span className="zotflow-csl-count">{count}</span>
        <div className="zotflow-csl-section-actions">
            {onUpdateAll && (
                <button
                    className="zotflow-csl-textbtn"
                    disabled={busy}
                    title={
                        checkedAt !== undefined
                            ? `Last checked ${fmtRelativeTime(checkedAt)}`
                            : "Never checked"
                    }
                    onClick={onUpdateAll}
                >
                    <ObsidianIcon icon="refresh-cw" />
                    <span>Update all</span>
                </button>
            )}
            <button
                className="clickable-icon"
                aria-label={`Add ${label.toLowerCase().replace(/s$/, "")}`}
                onClick={onAdd}
            >
                <ObsidianIcon icon="plus" />
            </button>
        </div>
    </div>
);

/* ---------------------------------------------------------------- */
/*  Style rows: parent + collapsed aliases                           */
/* ---------------------------------------------------------------- */

export interface StyleGroup {
    root: StyleInfo;
    /** Installed dependents whose parent is this root. */
    aliases: StyleInfo[];
}

export interface StyleRowHandlers {
    onOpen: (style: StyleInfo, group: StyleGroup) => void;
    onUpdate: (id: string) => void;
    onRemove: (style: StyleInfo) => void;
    onDownloadParent: (id: string) => void;
    onReveal: (style: StyleInfo) => void;
}

export const StyleRowGroup: React.FC<{
    group: StyleGroup;
    byId: Map<string, StyleInfo>;
    busy: boolean;
    updateFailed: boolean;
    handlers: StyleRowHandlers;
}> = ({ group, byId, busy, updateFailed, handlers }) => {
    const style = group.root;
    const state = rowState(style.availability);
    const isFolder = style.source === "folder";
    const caps = effectiveCaps(style, byId);
    const parentNeeded =
        state === "resolvable" && style.dependent ? style.parent : undefined;
    const reason = unavailableReason(style.availability);

    const metaParts: React.ReactNode[] = [
        <span className="zotflow-csl-mono" key="id">
            {style.id}
        </span>,
    ];
    if (group.aliases.length > 0) {
        metaParts.push(
            <span key="aliases">
                {group.aliases.length}{" "}
                {group.aliases.length === 1 ? "alias" : "aliases"}
            </span>,
        );
    }
    if (updateFailed) {
        metaParts.push(
            <span className="zotflow-csl-meta-warn" key="updfail">
                Update check failed
            </span>,
        );
    }
    if (parentNeeded) {
        metaParts.push(
            <span className="zotflow-csl-meta-warn" key="parent">
                Needs parent style “{parentNeeded}”
            </span>,
        );
    }
    if (state === "unavailable" && reason) {
        metaParts.push(
            <span className="zotflow-csl-meta-error" key="reason">
                {reason}
            </span>,
        );
    }

    return (
        <div className="zotflow-csl-group">
            <div
                className={`zotflow-csl-row${state === "unavailable" ? " zotflow-csl-row--broken" : ""}`}
                onClick={() => handlers.onOpen(style, group)}
            >
                <span className="zotflow-csl-row-status">
                    <LeadingStatus state={state} />
                </span>
                <div className="zotflow-csl-row-info">
                    <div className="zotflow-csl-row-title-line">
                        <span className="zotflow-csl-row-title">
                            {style.title ?? style.id}
                        </span>
                        <FormatBadge
                            format={caps.format}
                            inherited={caps.inherited}
                        />
                        <OutputBadges hasBib={caps.hasBib} />
                    </div>
                    <div className="zotflow-csl-row-meta">
                        {metaParts.map((part, i) => (
                            <React.Fragment key={i}>
                                {i > 0 && (
                                    <span className="zotflow-csl-meta-sep">
                                        ·
                                    </span>
                                )}
                                {part}
                            </React.Fragment>
                        ))}
                    </div>
                </div>
                <div
                    className="zotflow-csl-row-actions"
                    onClick={(e) => e.stopPropagation()}
                >
                    {state === "resolvable" && (
                        <button
                            className="zotflow-csl-chip-btn"
                            disabled={busy}
                            onClick={() => handlers.onDownloadParent(style.id)}
                        >
                            <ObsidianIcon icon="cloud" />
                            <span>Download</span>
                        </button>
                    )}
                    {/* Updated-time sits on the right, matching locale rows. */}
                    {!isFolder &&
                        !updateFailed &&
                        state === "ready" &&
                        style.remote && (
                            <span className="zotflow-csl-checked">
                                Updated{" "}
                                {fmtRelativeTime(style.remote.fetchedAt)}
                            </span>
                        )}
                    {isFolder ? (
                        <button
                            className="clickable-icon"
                            aria-label="Reveal in styles folder"
                            onClick={() => handlers.onReveal(style)}
                        >
                            <ObsidianIcon icon="folder-open" />
                        </button>
                    ) : (
                        <>
                            <button
                                className="clickable-icon"
                                aria-label="Check for updates"
                                disabled={busy}
                                onClick={() => handlers.onUpdate(style.id)}
                            >
                                <ObsidianIcon icon="refresh-cw" />
                            </button>
                            <button
                                className="clickable-icon zotflow-csl-danger"
                                aria-label={`Remove ${style.id}`}
                                disabled={busy}
                                onClick={() => handlers.onRemove(style)}
                            >
                                <ObsidianIcon icon="trash-2" />
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* Aliases collapse under their parent. One parent → many
                aliases. Aliases have no independent update (a dependent
                style is only <info>); deleting one removes just that entry
                and the shared parent is cleaned up by ref-count. */}
            {group.aliases.length > 0 && (
                <div className="zotflow-csl-alias-list">
                    {group.aliases.map((alias) => (
                        <div
                            className="zotflow-csl-alias-row"
                            key={alias.id}
                            onClick={() => handlers.onOpen(alias, group)}
                        >
                            <ObsidianIcon
                                icon="corner-down-right"
                                className="zotflow-csl-alias-arrow"
                            />
                            <span className="zotflow-csl-alias-title">
                                {alias.title ?? alias.id}
                            </span>
                            <span className="zotflow-csl-alias-id zotflow-csl-mono">
                                {alias.id}
                            </span>
                            {/* No type badge: an alias's format is the
                                parent's (shown one row above). */}
                            <div
                                className="zotflow-csl-alias-actions"
                                onClick={(e) => e.stopPropagation()}
                            >
                                <button
                                    className="clickable-icon zotflow-csl-danger"
                                    aria-label={`Remove alias ${alias.id}`}
                                    disabled={busy}
                                    onClick={() => handlers.onRemove(alias)}
                                >
                                    <ObsidianIcon icon="trash-2" />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

/* ---------------------------------------------------------------- */
/*  Locale row                                                       */
/* ---------------------------------------------------------------- */

function localeDisplayName(tag: string): string | undefined {
    try {
        return (
            new Intl.DisplayNames(undefined, { type: "language" }).of(tag) ??
            undefined
        );
    } catch {
        return undefined;
    }
}

export const LocaleRow: React.FC<{
    locale: LocaleInfo;
    busy: boolean;
    onUpdate: (tag: string) => void;
    onRemove: (tag: string) => void;
}> = ({ locale, busy, onUpdate, onRemove }) => {
    const name = localeDisplayName(locale.tag);
    return (
        <div className="zotflow-csl-row zotflow-csl-row--locale">
            <ObsidianIcon icon="globe" className="zotflow-csl-source-glyph" />
            <div className="zotflow-csl-row-info">
                <div className="zotflow-csl-row-title-line">
                    <span className="zotflow-csl-row-title zotflow-csl-mono">
                        {locale.tag}
                    </span>
                    {name && name !== locale.tag && (
                        <span className="zotflow-csl-row-subtle">{name}</span>
                    )}
                </div>
            </div>
            <div
                className="zotflow-csl-row-actions"
                onClick={(e) => e.stopPropagation()}
            >
                {locale.source === "builtin" && (
                    <>
                        {locale.fetchedAt !== undefined && (
                            <span className="zotflow-csl-checked">
                                Updated {fmtRelativeTime(locale.fetchedAt)}
                            </span>
                        )}
                        <button
                            className="clickable-icon"
                            aria-label={`Update ${locale.tag}`}
                            disabled={busy}
                            onClick={() => onUpdate(locale.tag)}
                        >
                            <ObsidianIcon icon="refresh-cw" />
                        </button>
                        {/* Occupies the delete slot: built-in, not removable. */}
                        <span
                            className="zotflow-csl-slot-glyph"
                            title="Built-in — bundled with the plugin, can't be removed. Updates overlay the bundled copy."
                        >
                            <ObsidianIcon icon="package" />
                        </span>
                    </>
                )}
                {locale.source === "folder" && (
                    <span className="zotflow-csl-row-subtle">
                        From styles folder
                    </span>
                )}
                {locale.source === "remote-cache" && (
                    <>
                        {locale.fetchedAt !== undefined && (
                            <span className="zotflow-csl-checked">
                                Updated {fmtRelativeTime(locale.fetchedAt)}
                            </span>
                        )}
                        <button
                            className="clickable-icon"
                            aria-label={`Update ${locale.tag}`}
                            disabled={busy}
                            onClick={() => onUpdate(locale.tag)}
                        >
                            <ObsidianIcon icon="refresh-cw" />
                        </button>
                        <button
                            className="clickable-icon zotflow-csl-danger"
                            aria-label={`Remove ${locale.tag}`}
                            disabled={busy}
                            onClick={() => onRemove(locale.tag)}
                        >
                            <ObsidianIcon icon="trash-2" />
                        </button>
                    </>
                )}
            </div>
        </div>
    );
};
