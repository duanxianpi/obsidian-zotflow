import { Setting, SettingGroup } from "obsidian";
import { workerBridge } from "bridge";
import { services } from "services/services";
import { errorMessage as describeError } from "utils/error";

import type ZotFlow from "main";

/** Settings section for WebDAV server URL, credentials, and connection verification. */
export class WebDavSection {
    constructor(
        private plugin: ZotFlow,
        private refreshUI: () => void,
    ) {}

    render(containerEl: HTMLElement) {
        const settingGroup = new SettingGroup(containerEl);
        settingGroup.setHeading("WebDAV Configuration");

        // Toggle
        settingGroup.addSetting((setting) => {
            setting
                .setName("Enable WebDAV Sync")
                .setDesc(
                    "Sync attachment files via a WebDAV server instead of Zotero Storage.",
                )
                .addToggle((toggle) =>
                    toggle
                        .setValue(this.plugin.settings.useWebDav)
                        .onChange(async (value) => {
                            this.plugin.settings.useWebDav = value;
                            if (!value) {
                                this.plugin.settings.webDavUrl = "";
                                this.plugin.settings.webDavUser = "";
                                this.plugin.settings.webdavpassword = "";
                            }
                            await this.plugin.saveSettings();
                            this.refreshUI();
                        }),
                );
        });

        if (!this.plugin.settings.useWebDav) return;

        const isVerified = !!this.plugin.settings.webDavUrl;
        let tempUrl = this.plugin.settings.webDavUrl || "";
        let tempUser = this.plugin.settings.webDavUser || "";
        let tempPassword = this.plugin.settings.webdavpassword || "";

        settingGroup.addSetting((setting) => {
            setting
                .setName("Server URL")
                .setDesc("e.g., https://webdav.service.com/zotero/")
                .addText((text) => {
                    text.setPlaceholder("https://...")
                        .setValue(tempUrl)
                        .onChange((v) => (tempUrl = v.trim()));
                    text.inputEl.setCssStyles({ width: "100%" });
                    if (isVerified) text.setDisabled(true);
                });
        });

        settingGroup.addSetting((setting) => {
            setting.setName("Username").addText((text) => {
                text.setPlaceholder("username")
                    .setValue(tempUser)
                    .onChange((v) => (tempUser = v.trim()));
                if (isVerified) text.setDisabled(true);
            });
        });

        settingGroup.addSetting((setting) => {
            setting.setName("Password").addText((text) => {
                text.setPlaceholder("password")
                    .setValue(tempPassword)
                    .onChange((v) => (tempPassword = v.trim()));
                text.inputEl.type = "password";
                if (isVerified) text.setDisabled(true);
            });

            const btnContainer = setting.settingEl.parentElement!.createDiv({
                cls: "zotflow-settings-btn-container",
            });

            if (isVerified) {
                new Setting(btnContainer).addButton((button) =>
                    button
                        .setButtonText("Disconnect")
                        .setIcon("unlink")
                        .setWarning()
                        .onClick(async () => {
                            this.plugin.settings.webDavUrl = "";
                            this.plugin.settings.webDavUser = "";
                            this.plugin.settings.webdavpassword = "";
                            await this.plugin.saveSettings();
                            services.notificationService.notify(
                                "info",
                                "WebDAV disconnected.",
                            );
                            this.refreshUI();
                        }),
                );
            } else {
                new Setting(btnContainer).addButton((button) =>
                    button
                        .setButtonText("Verify & Connect")
                        .setCta()
                        .onClick(async () => {
                            if (!tempUrl || !tempUser || !tempPassword) {
                                services.notificationService.notify(
                                    "warning",
                                    "Please fill in all fields.",
                                );
                                return;
                            }
                            button
                                .setButtonText("Verifying...")
                                .setDisabled(true);

                            try {
                                await workerBridge.webdav.verify(
                                    tempUrl,
                                    tempUser,
                                    tempPassword,
                                );
                                services.notificationService.notify(
                                    "success",
                                    "WebDAV Connected!",
                                );

                                this.plugin.settings.webDavUrl = tempUrl;
                                this.plugin.settings.webDavUser = tempUser;
                                this.plugin.settings.webdavpassword =
                                    tempPassword;

                                await this.plugin.saveSettings();

                                this.refreshUI();
                            } catch (error) {
                                services.logService.error(
                                    "WebDAV verification failed",
                                    "Settings",
                                    error,
                                );
                                services.notificationService.notify(
                                    "error",
                                    `Connection failed: ${describeError(error)}`,
                                );
                                button
                                    .setButtonText("Verify & Connect")
                                    .setDisabled(false);
                            }
                        }),
                );
            }
        });
    }
}
