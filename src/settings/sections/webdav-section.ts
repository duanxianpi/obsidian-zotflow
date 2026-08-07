import { workerBridge } from "bridge";
import { services } from "services/services";
import { errorMessage as describeError } from "utils/error";

import type ZotFlow from "main";
import type { SettingDefinitionItem } from "obsidian";
import type { SettingKey } from "settings/types";

interface WebDavDraft {
    url: string;
    user: string;
    password: string;
}

/** Declarative WebDAV settings with verify-before-save credentials. */
export class WebDavSection {
    private draft: WebDavDraft;

    constructor(
        private readonly plugin: ZotFlow,
        private readonly requestUpdate: () => void,
    ) {
        this.draft = this.createDraft();
    }

    getDefinitions(): SettingDefinitionItem<SettingKey>[] {
        const visible = () => this.plugin.settings.useWebDav;
        return [
            {
                type: "group",
                heading: "WebDAV Configuration",
                items: [
                    {
                        name: "Enable WebDAV Sync",
                        desc: "Sync attachment files via a WebDAV server instead of Zotero Storage.",
                        render: (setting) => {
                            setting.addToggle((toggle) =>
                                toggle
                                    .setValue(this.plugin.settings.useWebDav)
                                    .onChange(async (value) => {
                                        this.plugin.settings.useWebDav = value;
                                        if (!value) {
                                            this.plugin.settings.webDavUrl = "";
                                            this.plugin.settings.webDavUser =
                                                "";
                                            this.plugin.settings.webdavpassword =
                                                "";
                                            this.reset();
                                        }
                                        await this.plugin.saveSettings();
                                        this.requestUpdate();
                                    }),
                            );
                        },
                    },
                    {
                        name: "Server URL",
                        desc: "e.g., https://webdav.service.com/zotero/",
                        visible,
                        render: (setting) => {
                            setting.addText((text) => {
                                text.setPlaceholder("https://...")
                                    .setValue(this.draft.url)
                                    .setDisabled(this.isVerified())
                                    .onChange((value) => {
                                        this.draft.url = value.trim();
                                    });
                                text.inputEl.setCssStyles({ width: "100%" });
                            });
                        },
                    },
                    {
                        name: "Username",
                        visible,
                        render: (setting) => {
                            setting.addText((text) => {
                                text.setPlaceholder("username")
                                    .setValue(this.draft.user)
                                    .setDisabled(this.isVerified())
                                    .onChange((value) => {
                                        this.draft.user = value.trim();
                                    });
                            });
                        },
                    },
                    {
                        name: "Password",
                        visible,
                        render: (setting) => {
                            setting.addText((text) => {
                                text.setPlaceholder("password")
                                    .setValue(this.draft.password)
                                    .setDisabled(this.isVerified())
                                    .onChange((value) => {
                                        this.draft.password = value.trim();
                                    });
                                text.inputEl.type = "password";
                            });

                            setting.addButton((button) => {
                                if (this.isVerified()) {
                                    button
                                        .setButtonText("Disconnect")
                                        .setIcon("unlink")
                                        .setDestructive()
                                        .onClick(async () => {
                                            this.plugin.settings.webDavUrl = "";
                                            this.plugin.settings.webDavUser =
                                                "";
                                            this.plugin.settings.webdavpassword =
                                                "";
                                            await this.plugin.saveSettings();
                                            this.reset();
                                            services.notificationService.notify(
                                                "info",
                                                "WebDAV disconnected.",
                                            );
                                            this.requestUpdate();
                                        });
                                    return;
                                }

                                button
                                    .setButtonText("Verify & Connect")
                                    .setCta()
                                    .onClick(async () => {
                                        await this.verifyAndConnect(button);
                                    });
                            });
                        },
                    },
                ],
            },
        ];
    }

    reset(): void {
        this.draft = this.createDraft();
    }

    private createDraft(): WebDavDraft {
        return {
            url: this.plugin.settings.webDavUrl ?? "",
            user: this.plugin.settings.webDavUser ?? "",
            password: this.plugin.settings.webdavpassword ?? "",
        };
    }

    private isVerified(): boolean {
        return !!this.plugin.settings.webDavUrl;
    }

    private async verifyAndConnect(button: {
        setButtonText(text: string): unknown;
        setDisabled(disabled: boolean): unknown;
    }): Promise<void> {
        if (!this.draft.url || !this.draft.user || !this.draft.password) {
            services.notificationService.notify(
                "warning",
                "Please fill in all fields.",
            );
            return;
        }

        button.setButtonText("Verifying...");
        button.setDisabled(true);

        try {
            await workerBridge.webdav.verify(
                this.draft.url,
                this.draft.user,
                this.draft.password,
            );
            this.plugin.settings.webDavUrl = this.draft.url;
            this.plugin.settings.webDavUser = this.draft.user;
            this.plugin.settings.webdavpassword = this.draft.password;
            await this.plugin.saveSettings();
            services.notificationService.notify("success", "WebDAV Connected!");
            this.requestUpdate();
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
            button.setButtonText("Verify & Connect");
            button.setDisabled(false);
        }
    }
}
