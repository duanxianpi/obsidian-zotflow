import React, { useState } from "react";
import { ObsidianIcon } from "../ObsidianIcon";
import { SyncView } from "./SyncView";
import { TasksView } from "./TasksView";
import { TelemetryView } from "./TelemetryView";
import { TemplateTestView } from "./TemplateTestView";
import { RepairView } from "./RepairView";
import { CslStylesView } from "./CslStylesView";

/** Tab container React component with Sync, Tasks, Telemetry, Template, and Repair tabs. */
export const ZotFlowActivityCenter: React.FC = () => {
    const [activeTab, setActiveTab] = useState("sync");

    const tabs = [
        { id: "sync", label: "Sync", icon: "refresh-cw" },
        { id: "tasks", label: "Tasks", icon: "list" },
        { id: "template", label: "Template", icon: "code" },
        { id: "csl", label: "CSL", icon: "book-marked" },
        { id: "repair", label: "Repair", icon: "wrench" },
        { id: "telemetry", label: "Telemetry", icon: "activity" },
    ];

    return (
        <>
            <div className="zotflow-ac-tabs">
                {tabs.map((tab) => {
                    const isActive = activeTab === tab.id;
                    return (
                        <div
                            key={tab.id}
                            className={`zotflow-ac-tab ${isActive ? "is-active" : ""}`}
                            onClick={() => setActiveTab(tab.id)}
                        >
                            <span className="nav-icon">
                                <ObsidianIcon icon={tab.icon} />
                            </span>
                            <span className="zotflow-ac-tab-label">
                                {tab.label}
                            </span>
                        </div>
                    );
                })}
            </div>

            <div className="zotflow-ac-content">
                {activeTab === "sync" && <SyncView />}
                {activeTab === "tasks" && <TasksView />}
                {activeTab === "telemetry" && <TelemetryView />}
                {activeTab === "template" && <TemplateTestView />}
                {activeTab === "csl" && <CslStylesView />}
                {activeTab === "repair" && <RepairView />}
            </div>
        </>
    );
};
