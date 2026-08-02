import * as Comlink from "comlink";
import {
    Notice,
    requestUrl,
    App,
    TFile,
    normalizePath,
    MarkdownView,
    parseYaml,
    stringifyYaml,
    Platform,
} from "obsidian";
import {
    saveTextFile,
    saveBinaryFile,
    readTextFile,
    checkFile,
    deleteFile,
    getLinkedLocalSourceNote,
} from "utils/file";
import type { VaultConfig } from "bridge/types";
import { services } from "services/services";

import type { IParentProxy, IRequestResponse } from "./types";
import type { RequestUrlParam } from "obsidian";
import type { TFileWithoutParentAndVault } from "types/zotflow";
import type { NotificationType } from "services/notification-service";
import type { LogLevel } from "services/log-service";
import type { ITaskInfo } from "types/tasks";

/** Main-thread API exposed to the Worker via Comlink for filesystem, network, logging, and UI operations. */
export class ParentHost implements IParentProxy {
    constructor(private app: App) {}

    public notify(type: NotificationType, message: string) {
        services.notificationService.notify(type, message);
    }

    public log(
        level: LogLevel,
        message: string,
        context?: string,
        details?: any,
    ) {
        services.logService.log(level, message, context, details);
    }

    public async request(request: RequestUrlParam): Promise<IRequestResponse> {
        try {
            const req = {
                url: request.url,
                method: request.method,
                headers: request.headers,
                body: request.body,
                contentType: request.contentType,
            };
            const response = await requestUrl(request);
            const buffer = response.arrayBuffer;
            return Comlink.transfer(
                {
                    status: response.status,
                    headers: response.headers,
                    arrayBuffer: buffer,
                },
                [buffer],
            );
        } catch (error: any) {
            services.logService.error(
                `Fetch failed: ${error.message}`,
                "ParentHost",
            );
            throw new Error(`Network Error: ${error.message}`);
        }
    }

    public async isAndroidApp(): Promise<boolean> {
        return Platform.isAndroidApp;
    }

    public async readTextFile(path: string): Promise<string | null> {
        return readTextFile(this.app, path);
    }

    public async writeTextFile(path: string, content: string): Promise<void> {
        await saveTextFile(this.app, path, content);
    }

    public async writeBinaryFile(
        path: string,
        buffer: ArrayBuffer,
    ): Promise<void> {
        await saveBinaryFile(this.app, path, buffer);
    }

    public async checkFile(path: string): Promise<{
        exists: boolean;
        path: string;
        frontmatter?: Record<string, any>;
    }> {
        return checkFile(this.app, path);
    }

    public async openFile(path: string, newLeaf: boolean): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
        if (file instanceof TFile) {
            const leaves = this.app.workspace.getLeavesOfType("markdown");
            for (const leaf of leaves) {
                const view = leaf.view as MarkdownView;
                if (view.file && view.file.path === file.path) {
                    this.app.workspace.setActiveLeaf(leaf);
                    return;
                }
            }
            await this.app.workspace.getLeaf(newLeaf).openFile(file);
        }
    }

    public async getFileByKey(key: string): Promise<string | null> {
        await services.indexService.initializePromise;
        const file = services.indexService.getFileByKey(key);
        return file ? file.path : null;
    }

    public async indexFile(path: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
        if (file instanceof TFile) {
            services.indexService.indexFile(file);
        }
    }

    public async deleteFile(path: string): Promise<void> {
        await deleteFile(this.app, path);
    }

    public async readExternalBinaryFile(
        absolutePath: string,
    ): Promise<ArrayBuffer> {
        try {
            // Use Node.js fs directly — FileSystemAdapter prepends vault path
            // which breaks absolute OS paths. fs is available in Electron.
            const fs = require("fs").promises;
            const nodeBuffer: Buffer = await fs.readFile(absolutePath);
            const arrayBuffer = nodeBuffer.buffer.slice(
                nodeBuffer.byteOffset,
                nodeBuffer.byteOffset + nodeBuffer.byteLength,
            ) as ArrayBuffer;
            return Comlink.transfer(arrayBuffer, [arrayBuffer]);
        } catch (e: any) {
            throw new Error(`Failed to read external file: ${e.message}`);
        }
    }

    public async joinPath(...segments: string[]): Promise<string> {
        const path = require("path");
        return path.join(...segments) as string;
    }

    public async getVaultConfig(): Promise<VaultConfig> {
        // @ts-expect-error vault.config is undocumented Obsidian API
        return { ...this.app.vault.config };
    }

    public async parseYaml(text: string): Promise<Record<string, unknown>> {
        // Obsidian types this `any`; frontmatter is always a mapping.
        return parseYaml(text) as Record<string, unknown>;
    }

    public async stringifyYaml(obj: unknown): Promise<string> {
        return stringifyYaml(obj);
    }

    public async getLinkedLocalSourceNote(
        file: TFileWithoutParentAndVault,
    ): Promise<TFileWithoutParentAndVault | null> {
        return getLinkedLocalSourceNote(this.app, file);
    }

    public onTaskUpdate(taskId: string, info: ITaskInfo): void {
        services.taskMonitor.onTaskUpdate(taskId, info);
    }

    public onAnnotationChanged(
        libraryID: number,
        annotationKey: string,
        parentItemKey: string,
    ): void {
        services.taskMonitor.annotationChanged.emit(
            libraryID,
            annotationKey,
            parentItemKey,
        );
    }

    public onNoteChangedByEditor(
        libraryID: number,
        noteKey: string,
        parentItemKey: string,
    ): void {
        services.taskMonitor.noteChangedByEditor.emit(
            libraryID,
            noteKey,
            parentItemKey,
        );
    }

    public onNoteChangedByNoteView(
        libraryID: number,
        noteKey: string,
        parentItemKey: string,
    ): void {
        services.taskMonitor.noteChangedByNoteView.emit(
            libraryID,
            noteKey,
            parentItemKey,
        );
    }
}
