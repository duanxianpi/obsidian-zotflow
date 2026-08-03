import { Setting, SettingGroup } from "obsidian";

import { workerBridge } from "bridge";
import { DEFAULT_SETTINGS } from "settings/types";
import { services } from "services/services";

import type ZotFlow from "main";

/** Settings section for attachment cache toggle, size limit, usage bar, and purge. */
export class CacheSection {
    constructor(
        private plugin: ZotFlow,
        private refreshUI: () => void,
    ) {}

    async render(containerEl: HTMLElement) {
        const settingGroup = new SettingGroup(containerEl);
        settingGroup.setHeading("Attachment Cache");

        settingGroup.addSetting(async (setting) => {
            setting.setName("Enable Caching");
            setting.setDesc(
                "Save attachments locally to improve speed and work offline.",
            );
            setting.addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.useCache)
                    .onChange(async (value) => {
                        this.plugin.settings.useCache = value;
                        await this.plugin.saveSettings();
                        this.refreshUI();
                    }),
            );
        });

        if (!this.plugin.settings.useCache) return;

        // Max Size Setting
        settingGroup.addSetting(async (setting) => {
            setting.setName("Max Cache Limit (MB)");
            setting.setDesc("Set to 0 for unlimited.");
            setting.addText((text) => {
                text.setValue(
                    (
                        this.plugin.settings.maxCacheSizeMB ||
                        DEFAULT_SETTINGS.maxCacheSizeMB
                    ).toString(),
                ).onChange(async (value) => {
                    if (value && !/^[0-9]+$/.test(value)) {
                        services.notificationService.notify(
                            "warning",
                            "Must be a positive number",
                        );
                        return;
                    }
                    const newLimit = parseInt(value);
                    this.plugin.settings.maxCacheSizeMB = newLimit;
                    await this.plugin.saveSettings();
                    updateProgressBar(newLimit);
                });
            });

            // Cache Stats & Visualization
            const cacheConfigContainer =
                setting.settingEl.parentElement?.createDiv();
            let totalSizeBytes = 0;
            try {
                totalSizeBytes =
                    await workerBridge.attachment.getCacheTotalSizeBytes();
            } catch (e) {
                console.error("Cache stats error", e);
            }

            const usageContainer = cacheConfigContainer!.createDiv({
                cls: "zotflow-settings-cache-usage",
            });

            const infoDiv = usageContainer.createDiv({
                cls: "zotflow-settings-cache-info",
            });
            infoDiv.createSpan({ text: "Current Usage" });
            const usageTextEl = infoDiv.createSpan({ text: "Calculating..." });

            const progressBg = usageContainer.createDiv({
                cls: "zotflow-settings-cache-progress-bg",
            });

            const progressFillEl = progressBg.createDiv({
                cls: "zotflow-settings-cache-progress-fill",
            });

            // Logic to update bar
            const updateProgressBar = (limitMB: number) => {
                const totalSizeMB = (totalSizeBytes / (1024 * 1024)).toFixed(2);
                let percent = 0;
                let limitText = "Unlimited";

                if (limitMB > 0) {
                    percent = (totalSizeBytes / (limitMB * 1024 * 1024)) * 100;
                    limitText = `${limitMB} MB`;
                }

                usageTextEl.setText(`${totalSizeMB} MB / ${limitText}`);

                const visualPercent = Math.min(percent, 100);
                progressFillEl.style.width = `${visualPercent}%`;
                progressFillEl.style.backgroundColor =
                    percent > 90
                        ? "var(--text-error)"
                        : "var(--interactive-accent)";
            };

            // Initialize bar
            updateProgressBar(this.plugin.settings.maxCacheSizeMB);

            // Clear Cache Button
            const btnContainer = cacheConfigContainer!.createDiv({
                cls: "zotflow-settings-btn-container",
            });

            new Setting(btnContainer).addButton((btn) =>
                btn
                    .setButtonText("Purge Cache")
                    .setWarning()
                    .onClick(async () => {
                        try {
                            await workerBridge.attachment.purgeCache();
                            services.notificationService.notify(
                                "success",
                                "Cache purged successfully.",
                            );
                            services.logService.info(
                                "Cache purged successfully.",
                                "Settings",
                            );
                            totalSizeBytes = 0;
                            updateProgressBar(
                                this.plugin.settings.maxCacheSizeMB,
                            );
                        } catch (error) {
                            services.notificationService.notify(
                                "error",
                                "Failed to purge cache: " + error,
                            );
                            services.logService.error(
                                "Failed to purge cache: " + error,
                                "Settings",
                            );
                        }
                    }),
            );
        });
    }
}
