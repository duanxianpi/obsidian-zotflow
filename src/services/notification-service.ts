import { Notice, setIcon } from "obsidian";

/** Notification style type. */
export type NotificationType = "info" | "success" | "warning" | "error";

/** Optional actionable link rendered inside a notification. */
export interface NotificationLink {
    /** Visible link text. */
    text: string;
    /** Destination URL (opened in a new tab). */
    href: string;
}

/** Wraps Obsidian's `Notice` API with styled, icon-prefixed, type-aware notifications. */
export class NotificationService {
    /**
     * Display a stylised notification.
     *
     * @param type The urgency/type of the notification
     * @param message The content to display
     * @param link Optional link rendered after the message. When provided, the
     *             notification persists until dismissed so it can be clicked.
     */
    public notify(
        type: NotificationType,
        message: string,
        link?: NotificationLink,
    ) {
        let duration = 2000;
        let iconId;
        let colorVar;

        switch (type) {
            case "info":
                duration = 2000;
                // iconId = "info";
                // colorVar = "#FAFAFA";
                break;
            case "success":
                duration = 2000;
                iconId = "check-circle";
                colorVar = "var(--text-success)";
                break;
            case "warning":
                duration = 5000;
                iconId = "alert-triangle";
                colorVar = "var(--text-warning)";
                break;
            case "error":
                duration = 0;
                iconId = "alert-octagon";
                colorVar = "var(--text-error)";
                break;
        }

        // Notifications carrying a link persist until dismissed so the user has
        // time to click it.
        if (link) {
            duration = 0;
        }

        const fragment = createFragment();
        const container = fragment.createDiv({
            cls: "zotflow-notice-container",
        });

        if (iconId) {
            const iconEl = container.createSpan({
                cls: "zotflow-notice-icon",
            });
            setIcon(iconEl, iconId);
            if (colorVar) {
                iconEl.style.color = colorVar;
            }
        }

        const messageEl = container.createSpan({
            text: message,
            cls: "zotflow-notice-message",
        });

        if (link) {
            const linkEl = messageEl.createEl("a", {
                text: link.text,
                cls: "zotflow-notice-link",
                href: link.href,
            });
            linkEl.setAttribute("target", "_blank");
            linkEl.setAttribute("rel", "noopener");
        }

        new Notice(fragment, duration);
    }
}
