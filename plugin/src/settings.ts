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
}

export const DEFAULT_SETTINGS: SyncSettings = {
	serverUrl: "",
	token: "",
	deviceName: "",
	// workspace.json holds window state: it differs per device and only gets in the way.
	excludes: [".obsidian/workspace.json", ".obsidian/workspace-mobile.json", ".trash/"],
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

		new Setting(containerEl).setName(t("settings.section.maintenance")).setHeading();

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
