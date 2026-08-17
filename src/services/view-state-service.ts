import type { Plugin } from "obsidian";
import type { LogService } from "./log-service";
import type {
    ViewStateEntry,
    ZotFlowPluginData,
    ZotFlowSettings,
} from "settings/types";
import type { CustomReaderTheme } from "types/zotero-reader";
import { stripCredentials } from "utils/credentials";

const VIEW_STATE_SAVE_DEBOUNCE_MS = 1_000;

/**
 * ViewStateService manages persisted reader view states for both local
 * (vault file) and remote (Zotero cloud) attachments in a single map.
 *
 * Local attachments are keyed by vault file path.
 * Remote attachments are keyed by `"libraryID:itemKey"`.
 *
 * All state is persisted to `data.json` via a shared debounce timer.
 */
export class ViewStateService {
    private _settingsGetter: () => ZotFlowSettings;

    constructor(
        private _plugin: Plugin,
        private _logService: LogService,
        settingsGetter: () => ZotFlowSettings,
    ) {
        this._settingsGetter = settingsGetter;
    }

    private _viewStates: Record<string, ViewStateEntry> = {};
    /** `window.setTimeout` handle — a number, unlike Node's `Timeout`. */
    private _viewStateSaveTimer: number | undefined;
    private _customThemes: CustomReaderTheme[] = [];

    /** Bulk-set the in-memory view state map (called once during plugin load). */
    setViewStates(states: Record<string, ViewStateEntry>) {
        this._viewStates = states;
    }

    /** Bulk-set custom themes (called once during plugin load). */
    setCustomThemes(themes: CustomReaderTheme[]) {
        this._customThemes = themes;
    }

    /** Get the current custom themes array. */
    getCustomThemes(): CustomReaderTheme[] {
        return this._customThemes;
    }

    /** Persist new custom themes and schedule a debounced save. */
    saveCustomThemes(themes: CustomReaderTheme[]): void {
        this._customThemes = themes;
        this.schedulePersistViewStates();
    }

    /** Get persisted view state by key. */
    getViewState(key: string): ViewStateEntry | undefined {
        return this._viewStates[key];
    }

    /**
     * Build the composite key for a remote attachment.
     * Remote keys use `"libraryID:itemKey"` to avoid collisions with file paths.
     */
    static remoteKey(libraryID: number, itemKey: string): string {
        return `${libraryID}:${itemKey}`;
    }

    /** Save (or update) view state for any attachment and schedule a debounced persist. */
    saveViewState(
        key: string,
        primary: boolean,
        state: Record<string, unknown>,
    ): void {
        const entry = this._viewStates[key] ?? {};

        // Deepcopy, remove the reader realm
        const safeState = JSON.parse(JSON.stringify(state)) as Record<
            string,
            unknown
        >;

        if (primary) {
            entry.primaryViewState = safeState;
        } else {
            entry.secondaryViewState = safeState;
        }

        this._viewStates[key] = entry;
        this.schedulePersistViewStates();
    }

    /** Save a theme preference for an attachment and schedule a debounced persist. */
    saveTheme(key: string, kind: "light" | "dark", theme: unknown): void {
        const entry = this._viewStates[key] ?? {};
        if (kind === "light") {
            entry.lightTheme = theme as string | undefined;
        } else {
            entry.darkTheme = theme as string | undefined;
        }
        this._viewStates[key] = entry;
        this.schedulePersistViewStates();
    }

    /** Update the key when a local attachment file is renamed. */
    renameViewState(oldKey: string, newKey: string): void {
        const entry = this._viewStates[oldKey];
        if (entry) {
            delete this._viewStates[oldKey];
            this._viewStates[newKey] = entry;
            this.schedulePersistViewStates();
        }
    }

    /** Remove view state for a deleted attachment. */
    deleteViewState(key: string): void {
        if (key in this._viewStates) {
            delete this._viewStates[key];
            this.schedulePersistViewStates();
        }
    }

    /** Flush any pending view-state save immediately (call in onunload). */
    flushViewStateSave(): void {
        if (this._viewStateSaveTimer !== undefined) {
            window.clearTimeout(this._viewStateSaveTimer);
            this._viewStateSaveTimer = undefined;
            this.persistViewStates();
        }
    }

    /** Return the raw map (used by main.ts when building the data.json blob). */
    getViewStatesMap(): Record<string, ViewStateEntry> {
        return this._viewStates;
    }

    private schedulePersistViewStates(): void {
        if (this._viewStateSaveTimer !== undefined) {
            window.clearTimeout(this._viewStateSaveTimer);
        }
        this._viewStateSaveTimer = window.setTimeout(() => {
            this._viewStateSaveTimer = undefined;
            this.persistViewStates();
        }, VIEW_STATE_SAVE_DEBOUNCE_MS);
    }

    private persistViewStates(): void {
        const data: ZotFlowPluginData = {
            settings: stripCredentials(this._settingsGetter()),
            customThemes: this._customThemes,
            viewStates: this._viewStates,
        };
        this._plugin.saveData(data).catch((e: unknown) => {
            this._logService?.warn(
                "Failed to persist view states to data.json",
                "ViewStateService",
                e,
            );
        });
    }
}
