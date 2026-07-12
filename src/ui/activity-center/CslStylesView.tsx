import React, { useCallback, useEffect, useState } from "react";
import { Platform } from "obsidian";
import { workerBridge } from "bridge";
import { services } from "services/services";
import { ObsidianIcon } from "ui/ObsidianIcon";
import { AddCslLocaleModal, AddCslStyleModal } from "ui/modals/csl-add-modal";
import { StyleDetailsModal } from "ui/modals/csl-details-modal";
import {
    effectiveCaps,
    LocaleRow,
    rowState,
    SectionHeader,
    StyleRowGroup,
    unavailableReason,
} from "ui/activity-center/CslRows";

import type { LocaleInfo, StyleInfo, UpdateAllReport } from "worker/csl";
import type { StyleGroup } from "ui/activity-center/CslRows";
import type { StyleDetailsMeta } from "ui/modals/csl-style-details";

/** Parent-first grouping: installed aliases collapse under their parent. */
function groupStyles(styles: StyleInfo[]): {
    groups: StyleGroup[];
    byId: Map<string, StyleInfo>;
} {
    const byId = new Map(styles.map((s) => [s.id, s]));
    const aliasesByParent = new Map<string, StyleInfo[]>();
    const roots: StyleInfo[] = [];
    for (const s of styles) {
        if (s.dependent && s.parent && byId.has(s.parent)) {
            const list = aliasesByParent.get(s.parent) ?? [];
            list.push(s);
            aliasesByParent.set(s.parent, list);
        } else {
            roots.push(s);
        }
    }
    return {
        groups: roots.map((root) => ({
            root,
            aliases: aliasesByParent.get(root.id) ?? [],
        })),
        byId,
    };
}

function updateSummary(report: UpdateAllReport): string {
    if (report.failed.length > 0) {
        return `Update incomplete — failed: ${report.failed
            .map((f) => f.id)
            .join(", ")}`;
    }
    if (report.updated.length === 0) return "Everything is up to date";
    return `Updated ${report.updated.join(", ")}`;
}

/** CSL tab: manage citation styles and locales for the CSL renderer. */
export const CslStylesView: React.FC = () => {
    const [styles, setStyles] = useState<StyleInfo[]>([]);
    const [locales, setLocales] = useState<LocaleInfo[]>([]);
    const [checked, setChecked] = useState<{
        styles?: number;
        locales?: number;
    }>({});
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    // Update failures are session-scoped row markers, not persisted state.
    const [updateFailures, setUpdateFailures] = useState<Set<string>>(
        new Set(),
    );

    const refresh = useCallback(async () => {
        try {
            const [styleList, localeList, status] = await Promise.all([
                workerBridge.cslRender.listStyles(),
                workerBridge.cslRender.listLocales(),
                workerBridge.cslRender.getUpdateStatus(),
            ]);
            setStyles(styleList);
            setLocales(localeList);
            setChecked({
                styles: status.stylesCheckedAt,
                locales: status.localesCheckedAt,
            });
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

    const markFailures = useCallback(
        (failed: { id: string }[], succeeded: string[]) => {
            setUpdateFailures((prev) => {
                const next = new Set(prev);
                for (const id of succeeded) next.delete(id);
                for (const f of failed) next.add(f.id);
                return next;
            });
        },
        [],
    );

    const run = useCallback(
        async (task: () => Promise<void>) => {
            setBusy(true);
            try {
                await task();
            } finally {
                setBusy(false);
                await refresh();
            }
        },
        [refresh],
    );

    /* ------------------------- style handlers ---------------------- */

    const handleUpdateStyle = useCallback(
        (id: string) =>
            void run(async () => {
                try {
                    const report =
                        await workerBridge.cslRender.updateStyle(id);
                    markFailures(report.failed, [
                        ...report.updated,
                        ...report.unchanged,
                    ]);
                    services.notificationService.notify(
                        report.failed.length > 0 ? "warning" : "success",
                        report.failed.length > 0
                            ? `"${id}": update incomplete`
                            : report.updated.length > 0
                              ? `Updated ${report.updated.join(", ")}`
                              : `"${id}" is already up to date`,
                    );
                } catch (e) {
                    services.logService.error(
                        `Failed to update style ${id}`,
                        "CslStylesView",
                        e,
                    );
                    markFailures([{ id }], []);
                    services.notificationService.notify(
                        "error",
                        `Failed to update "${id}".`,
                    );
                }
            }),
        [markFailures, run],
    );

    const handleUpdateAllStyles = useCallback(
        () =>
            void run(async () => {
                try {
                    const report =
                        await workerBridge.cslRender.updateAllStyles();
                    markFailures(report.failed, [
                        ...report.updated,
                        ...report.unchanged,
                    ]);
                    services.notificationService.notify(
                        report.failed.length > 0 ? "warning" : "success",
                        updateSummary(report),
                    );
                } catch (e) {
                    services.logService.error(
                        "Failed to update styles",
                        "CslStylesView",
                        e,
                    );
                    services.notificationService.notify(
                        "error",
                        "Style update check failed.",
                    );
                }
            }),
        [markFailures, run],
    );

    const handleRemoveStyle = useCallback(
        (style: StyleInfo) =>
            void run(async () => {
                try {
                    await workerBridge.cslRender.removeStyle(style.id);
                    services.notificationService.notify(
                        "success",
                        `Removed "${style.id}"`,
                    );
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
                }
            }),
        [run],
    );

    const handleDownloadParent = useCallback(
        (id: string) =>
            void run(async () => {
                const avail = await workerBridge.cslRender.resolveDeps(id);
                services.notificationService.notify(
                    avail.status === "ready" ? "success" : "warning",
                    avail.status === "ready"
                        ? `"${id}" is ready`
                        : `"${id}" still has unresolved dependencies`,
                );
            }),
        [run],
    );

    const handleReveal = useCallback((style: StyleInfo) => {
        if (!Platform.isDesktopApp) {
            services.notificationService.notify(
                "info",
                "Revealing files is available on desktop only.",
            );
            return;
        }
        const folder = services.settings.cslStylesFolder;
        services.app.showInFolder(
            folder ? `${folder}/${style.id}.csl` : `${style.id}.csl`,
        );
    }, []);

    const openDetails = useCallback(
        (style: StyleInfo, group: StyleGroup, byId: Map<string, StyleInfo>) => {
            const isAlias =
                !!style.dependent &&
                !!style.parent &&
                byId.has(style.parent) &&
                style.id !== group.root.id;
            const caps = effectiveCaps(style, byId);
            const parent = style.parent ? byId.get(style.parent) : undefined;
            const isFolder = style.source === "folder";
            const folder = services.settings.cslStylesFolder;
            const meta: StyleDetailsMeta = {
                id: style.id,
                title: style.title,
                citationFormat: caps.format,
                formatInherited: caps.inherited,
                hasBibliography: caps.hasBib,
                defaultLocale: style.defaultLocale ?? parent?.defaultLocale,
                source: isFolder ? "folder" : "remote",
                sourceUrl: style.remote?.sourceUrl,
                filePath: isFolder
                    ? `${folder ? `${folder}/` : ""}${style.id}.csl`
                    : undefined,
                aliasOf: style.dependent ? style.parent : undefined,
                aliasCount: isAlias ? undefined : group.aliases.length,
            };
            const state = rowState(style.availability);
            new StyleDetailsModal(
                services.app,
                {
                    meta,
                    state,
                    reason: unavailableReason(style.availability),
                    parentNeeded:
                        state === "resolvable" ? style.parent : undefined,
                    isAlias,
                    updateFailed: updateFailures.has(style.id),
                },
                {
                    onUpdate: isFolder
                        ? undefined
                        : () => handleUpdateStyle(style.id),
                    onDownloadParent: () => handleDownloadParent(style.id),
                    onRemove: isFolder
                        ? undefined
                        : () => handleRemoveStyle(style),
                    onReveal: isFolder ? () => handleReveal(style) : undefined,
                },
            ).open();
        },
        [
            handleDownloadParent,
            handleRemoveStyle,
            handleReveal,
            handleUpdateStyle,
            updateFailures,
        ],
    );

    /* ------------------------ locale handlers ---------------------- */

    const handleUpdateLocale = useCallback(
        (tag: string) =>
            void run(async () => {
                try {
                    const { updated } =
                        await workerBridge.cslRender.updateLocale(tag);
                    services.notificationService.notify(
                        "success",
                        updated
                            ? `Locale "${tag}" updated`
                            : `Locale "${tag}" is already up to date`,
                    );
                } catch (e) {
                    services.logService.error(
                        `Failed to update locale ${tag}`,
                        "CslStylesView",
                        e,
                    );
                    services.notificationService.notify(
                        "error",
                        `Failed to update locale "${tag}".`,
                    );
                }
            }),
        [run],
    );

    const handleUpdateAllLocales = useCallback(
        () =>
            void run(async () => {
                try {
                    const report =
                        await workerBridge.cslRender.updateAllLocales();
                    services.notificationService.notify(
                        report.failed.length > 0 ? "warning" : "success",
                        updateSummary(report),
                    );
                } catch (e) {
                    services.logService.error(
                        "Failed to update locales",
                        "CslStylesView",
                        e,
                    );
                    services.notificationService.notify(
                        "error",
                        "Locale update check failed.",
                    );
                }
            }),
        [run],
    );

    const handleRemoveLocale = useCallback(
        (tag: string) =>
            void run(async () => {
                await workerBridge.cslRender.removeLocale(tag);
            }),
        [run],
    );

    /* ----------------------------- render -------------------------- */

    const { groups, byId } = groupStyles(styles);
    const remoteLocales = locales.filter((l) => l.source === "remote-cache");

    return (
        <div className="zotflow-csl-view">
            <div className="zotflow-csl-section zotflow-csl-section--styles">
                <SectionHeader
                    label="Styles"
                    count={styles.length}
                    checkedAt={checked.styles}
                    busy={busy}
                    onUpdateAll={
                        styles.some((s) => s.source === "remote-cache")
                            ? handleUpdateAllStyles
                            : undefined
                    }
                    onAdd={() =>
                        new AddCslStyleModal(
                            services.app,
                            () => void refresh(),
                        ).open()
                    }
                />
                <div className="zotflow-csl-list">
                    {loading && (
                        <div className="zotflow-csl-empty">
                            <ObsidianIcon
                                icon="loader"
                                className="zotflow-spin"
                            />
                            <span>Loading…</span>
                        </div>
                    )}
                    {!loading && styles.length === 0 && (
                        <div className="zotflow-csl-empty">
                            <ObsidianIcon icon="info" />
                            <span>
                                No styles yet — click + and enter a style id
                                from zotero.org/styles.
                            </span>
                        </div>
                    )}
                    {groups.map((group) => (
                        <StyleRowGroup
                            key={group.root.id}
                            group={group}
                            byId={byId}
                            busy={busy}
                            updateFailed={updateFailures.has(group.root.id)}
                            handlers={{
                                onOpen: (style, g) =>
                                    openDetails(style, g, byId),
                                onUpdate: handleUpdateStyle,
                                onRemove: handleRemoveStyle,
                                onDownloadParent: handleDownloadParent,
                                onReveal: handleReveal,
                            }}
                        />
                    ))}
                </div>
            </div>

            <div className="zotflow-csl-section zotflow-csl-section--locales">
                <SectionHeader
                    label="Locales"
                    count={locales.length}
                    checkedAt={checked.locales}
                    busy={busy}
                    onUpdateAll={
                        remoteLocales.length > 0
                            ? handleUpdateAllLocales
                            : undefined
                    }
                    onAdd={() =>
                        new AddCslLocaleModal(
                            services.app,
                            () => void refresh(),
                        ).open()
                    }
                />
                <div className="zotflow-csl-list">
                    {locales.map((locale) => (
                        <LocaleRow
                            key={locale.tag}
                            locale={locale}
                            busy={busy}
                            onUpdate={handleUpdateLocale}
                            onRemove={handleRemoveLocale}
                        />
                    ))}
                </div>
                <p className="zotflow-csl-footnote">
                    Locales download automatically when a style needs them.
                    en-US is always available offline.
                </p>
            </div>
        </div>
    );
};
