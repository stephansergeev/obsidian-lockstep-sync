// SPDX-License-Identifier: MIT

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { t } from "./i18n";
import type LockstepPlugin from "./main";

export interface SyncSettings {
	serverUrl: string;
	token: string;
	deviceName: string;
	/** Paths that never leave this device, whatever else is configured. */
	excludes: string[];
	autoSync: boolean;
	/** Seconds between background passes. */
	intervalSeconds: number;
}

export const DEFAULT_SETTINGS: SyncSettings = {
	serverUrl: "",
	token: "",
	deviceName: "",
	// workspace.json holds window state: it differs per device and only gets in the way.
	excludes: [".obsidian/workspace.json", ".obsidian/workspace-mobile.json", ".trash/"],
	autoSync: true,
	intervalSeconds: 60,
};

export class SyncSettingsTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: LockstepPlugin,
	) {
		super(app, plugin);
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName(t("settings.serverUrl.name"))
			.setDesc(t("settings.serverUrl.desc"))
			.addText((text) =>
				text
					.setPlaceholder("https://sync.example.com")
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (v) => {
						this.plugin.settings.serverUrl = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t("settings.token.name"))
			.setDesc(t("settings.token.desc"))
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("obs_…")
					.setValue(this.plugin.settings.token)
					.onChange(async (v) => {
						this.plugin.settings.token = v.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName(t("settings.device.name"))
			.setDesc(t("settings.device.desc"))
			.addText((text) =>
				text
					.setPlaceholder("iphone")
					.setValue(this.plugin.settings.deviceName)
					.onChange(async (v) => {
						this.plugin.settings.deviceName = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t("settings.excludes.name"))
			.setDesc(t("settings.excludes.desc"))
			.addTextArea((text) =>
				text.setValue(this.plugin.settings.excludes.join("\n")).onChange(async (v) => {
					this.plugin.settings.excludes = v
						.split("\n")
						.map((s) => s.trim())
						.filter(Boolean);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(t("settings.autoSync.name"))
			.setDesc(t("settings.autoSync.desc"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSync).onChange(async (v) => {
					this.plugin.settings.autoSync = v;
					await this.plugin.saveSettings();
					this.plugin.restartAutoSync();
				}),
			);

		new Setting(containerEl)
			.setName(t("settings.interval.name"))
			.setDesc(t("settings.interval.desc"))
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.intervalSeconds))
					.onChange(async (v) => {
						const n = Number(v);
						if (!Number.isFinite(n)) return;
						this.plugin.settings.intervalSeconds = Math.max(15, Math.round(n));
						await this.plugin.saveSettings();
						this.plugin.restartAutoSync();
					}),
			);

		new Setting(containerEl).setName(t("settings.section.maintenance")).setHeading();

		new Setting(containerEl)
			.setName(t("settings.sync.name"))
			.setDesc(t("settings.sync.desc"))
			.addButton((b) =>
				b.setCta().setButtonText(t("settings.sync.button")).onClick(async () => {
					await this.plugin.syncNow();
				}),
			);

		new Setting(containerEl)
			.setName(t("settings.test.name"))
			.setDesc(t("settings.test.desc"))
			.addButton((b) =>
				b.setButtonText(t("settings.test.button")).onClick(async () => {
					await this.plugin.testConnection();
				}),
			);

		new Setting(containerEl)
			.setName(t("settings.pull.name"))
			.setDesc(t("settings.pull.desc"))
			.addButton((b) =>
				b.setButtonText(t("settings.pull.button")).onClick(async () => {
					await this.plugin.pullAll();
				}),
			);

		new Setting(containerEl)
			.setName(t("settings.reset.name"))
			.setDesc(t("settings.reset.desc"))
			.addButton((b) =>
				b
					.setWarning()
					.setButtonText(t("settings.reset.button"))
					.onClick(async () => {
						await this.plugin.resetIndex();
						new Notice(t("notice.indexReset"));
					}),
			);

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: this.plugin.statusLine(),
		});
	}
}
