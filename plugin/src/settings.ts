// SPDX-License-Identifier: MIT

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type SelfHostedSyncPlugin from "./main";

export interface SyncSettings {
	serverUrl: string;
	token: string;
	deviceName: string;
	/** Пути, которые не уезжают на сервер ни при каких настройках. */
	excludes: string[];
}

export const DEFAULT_SETTINGS: SyncSettings = {
	serverUrl: "",
	token: "",
	deviceName: "",
	// workspace.json — состояние окон, оно у каждого устройства своё и синку только мешает.
	excludes: [".obsidian/workspace.json", ".obsidian/workspace-mobile.json", ".trash/"],
};

export class SyncSettingsTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: SelfHostedSyncPlugin,
	) {
		super(app, plugin);
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Адрес сервера")
			.setDesc("Например https://sync.example.com — без /v1 на конце.")
			.addText((t) =>
				t
					.setPlaceholder("https://sync.example.com")
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (v) => {
						this.plugin.settings.serverUrl = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Токен устройства")
			.setDesc("Выдаётся командой sync-server token add --name <устройство>. Показывается один раз.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("obs_…")
					.setValue(this.plugin.settings.token)
					.onChange(async (v) => {
						this.plugin.settings.token = v.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Имя устройства")
			.setDesc("Подставляется в имена конфликтных копий, чтобы было видно, откуда правка.")
			.addText((t) =>
				t
					.setPlaceholder("iphone")
					.setValue(this.plugin.settings.deviceName)
					.onChange(async (v) => {
						this.plugin.settings.deviceName = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Исключения")
			.setDesc("По строке на путь или префикс. Эти файлы не уезжают на сервер.")
			.addTextArea((t) =>
				t
					.setValue(this.plugin.settings.excludes.join("\n"))
					.onChange(async (v) => {
						this.plugin.settings.excludes = v
							.split("\n")
							.map((s) => s.trim())
							.filter(Boolean);
						await this.plugin.saveSettings();
					}),
			);

		containerEl.createEl("h3", { text: "Проверка и обслуживание" });

		new Setting(containerEl)
			.setName("Проверить соединение")
			.setDesc("Дёргает /health и /stats — сразу видно, тот ли токен и тот ли волт.")
			.addButton((b) =>
				b.setButtonText("Проверить").onClick(async () => {
					await this.plugin.testConnection();
				}),
			);

		new Setting(containerEl)
			.setName("Скачать всё с сервера")
			.setDesc(
				"Односторонняя операция M0: локальные файлы не удаляются, а расхождения " +
					"сохраняются копией рядом. Ничего не перезаписывается молча.",
			)
			.addButton((b) =>
				b.setButtonText("Скачать").onClick(async () => {
					await this.plugin.pullAll();
				}),
			);

		new Setting(containerEl)
			.setName("Сбросить локальный индекс")
			.setDesc("Индекс перестроится при следующем скачивании. Файлы волта не трогаются.")
			.addButton((b) =>
				b.setWarning().setButtonText("Сбросить").onClick(async () => {
					await this.plugin.resetIndex();
					new Notice("Индекс сброшен");
				}),
			);

		const status = containerEl.createEl("p", { cls: "setting-item-description" });
		status.setText(this.plugin.statusLine());
	}
}
