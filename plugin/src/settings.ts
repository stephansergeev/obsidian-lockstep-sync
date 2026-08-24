// SPDX-License-Identifier: MIT

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { otherSideLabel } from "./conflict-notice";
import { t } from "./i18n";
import { defaultDeviceName } from "./paths";
import { MIN_PASSPHRASE, judgePassphrase } from "./crypto";
import type LockstepPlugin from "./main";

export interface SyncSettings {
	serverUrl: string;
	token: string;
	deviceName: string;
	/** Paths that never leave this device, whatever else is configured. */
	excludes: string[];
	autoSync: boolean;
	/** Encrypt content before it leaves the device. */
	encryption: boolean;
	/**
	 * The passphrase, kept in the plugin's own settings file inside the vault.
	 *
	 * That file sits on a device you already control, and the threat this encryption
	 * answers is the server, not your own laptop. Asking for a passphrase on every
	 * launch would mostly train people to turn encryption off.
	 */
	passphrase: string;
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
	encryption: false,
	passphrase: "",
	intervalSeconds: 60,
};

export class SyncSettingsTab extends PluginSettingTab {
	/** Held so the field does not blank out while the server is being asked. */
	private retentionValue = "";

	constructor(
		app: App,
		private plugin: LockstepPlugin,
	) {
		super(app, plugin);
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Whether the server can read this vault is the first thing on the screen,
		// stated in a sentence rather than inferred from a toggle being on. A setting
		// that is on and a vault that is actually hidden are not the same thing, and
		// the difference is the whole point of the feature.
		this.renderState(containerEl);

		// Anything waiting on a decision goes next. This is the screen people open
		// when they were told something needs deciding.
		this.renderConflicts(containerEl);

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

		// Which vault on the server this token opens. What the vault is called in
		// Obsidian is local to this device and travels nowhere, so the two names are
		// unrelated and somebody with several vaults needs to see the one that binds.
		const vaultRow = new Setting(containerEl)
			.setName(t("settings.serverVault.name"))
			.setDesc(t("settings.serverVault.desc"));
		const vaultValue = vaultRow.controlEl.createSpan({
			cls: "lockstep-vault-name",
			text: this.plugin.serverVaultName() || t("settings.serverVault.unknown"),
		});
		void this.plugin.refreshServerVault().then(() => {
			vaultValue.setText(this.plugin.serverVaultName() || t("settings.serverVault.unknown"));
		});

		new Setting(containerEl)
			.setName(t("settings.device.name"))
			.setDesc(t("settings.device.desc"))
			.addText((text) =>
				text
					.setPlaceholder(defaultDeviceName())
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
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "15";
				text.inputEl.setAttribute("aria-label", t("settings.interval.unit"));
				text
					.setValue(String(this.plugin.settings.intervalSeconds))
					.onChange(async (v) => {
						const n = Number(v);
						if (!Number.isFinite(n)) return;
						this.plugin.settings.intervalSeconds = Math.max(15, Math.round(n));
						await this.plugin.saveSettings();
						this.plugin.restartAutoSync();
					});
			});

		new Setting(containerEl).setName(t("settings.section.encryption")).setHeading();

		new Setting(containerEl)
			.setName(t("settings.encryption.name"))
			.setDesc(t("settings.encryption.desc"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.encryption).onChange(async (v) => {
					this.plugin.settings.encryption = v;
					await this.plugin.saveSettings();
					await this.plugin.applyEncryption();
					this.display();
				}),
			);

		if (this.plugin.settings.encryption) {
			// Setting a passphrase up and entering an existing one are different acts
			// with different stakes, and until now they looked identical.
			if (this.plugin.vaultNeedsSetup()) {
				const warn = containerEl.createDiv({ cls: "lockstep-banner is-locked" });
				const body = warn.createDiv({ cls: "lockstep-banner-text" });
				body.createDiv({
					cls: "lockstep-banner-title",
					text: t("settings.passphrase.firstTime"),
				});
				body.createDiv({
					cls: "lockstep-banner-detail",
					text: t("settings.passphrase.oneChance"),
				});
			}

			const judgement = containerEl.createDiv({ cls: "setting-item-description" });
			const judge = (value: string) => {
				if (!value) {
					judgement.setText("");
					return;
				}
				const verdict = judgePassphrase(value);
				judgement.setText(t(`settings.passphrase.${verdict}`));
				judgement.toggleClass("lockstep-warning", verdict !== "good");
			};

			new Setting(containerEl)
				.setName(t("settings.passphrase.name"))
				.setDesc(t("settings.passphrase.desc"))
				.addText((text) => {
					text.inputEl.type = "password";
					if (this.plugin.takeFocusRequest()) {
						// The reason this screen was opened. Put the cursor where the one
						// remaining step is instead of leaving it to be found.
						window.setTimeout(() => {
							text.inputEl.focus();
							text.inputEl.scrollIntoView({ block: "center" });
						}, 50);
					}
					text.setValue(this.plugin.settings.passphrase).onChange(async (v) => {
						this.plugin.settings.passphrase = v;
						await this.plugin.saveSettings();
						judge(v);
					});
					judge(this.plugin.settings.passphrase);
					// Leaving the field is as good a signal as pressing a button, and
					// one fewer thing to know about.
					text.inputEl.addEventListener("blur", async () => {
						if (!this.plugin.settings.passphrase) return;
						// Only refused where it would be written into a vault for good.
						// Somebody entering an existing short one is not the person who
						// chose it, and blocking them helps nobody.
						if (
							this.plugin.vaultNeedsSetup() &&
							this.plugin.settings.passphrase.length < MIN_PASSPHRASE
						) {
							new Notice(t("settings.passphrase.tooShort", { min: MIN_PASSPHRASE }), 10000);
							return;
						}
						try {
							await this.plugin.applyEncryption();
						} catch {
							/* already reported */
						}
						this.display();
					});
				})
				.addButton((b) =>
					b.setButtonText(t("settings.passphrase.button")).onClick(async () => {
						await this.plugin.applyEncryption();
						this.display();
					}),
				);

			// Stated as its own line rather than as a caption: this is the answer to
			// the only question somebody turning encryption on actually has.
			new Setting(containerEl).setName(this.plugin.encryptionStatus()).setDesc(
				this.plugin.encryptionReady()
					? t("encryption.explainHidden")
					: t("encryption.explainNotHidden"),
			);
		}

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
			.setName(t("settings.addDevice.name"))
			.setDesc(t("settings.addDevice.desc"))
			.addButton((b) =>
				b.setCta().setButtonText(t("settings.addDevice.button")).onClick(() => {
					this.plugin.openAddDevice();
				}),
			);

		new Setting(containerEl)
			.setName(t("settings.retention.name"))
			.setDesc(t("settings.retention.desc"))
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.inputEl.max = "3650";
				text.setPlaceholder("30").setValue(this.retentionValue);
				text.inputEl.addEventListener("blur", async () => {
					const days = Number(text.getValue());
					if (!Number.isFinite(days) || days < 0 || days > 3650) return;
					try {
						await this.plugin.setRetention(days);
						this.retentionValue = String(days);
						new Notice(
							days === 0
								? t("settings.retention.forever")
								: t("settings.retention.saved", { days }),
						);
					} catch (e) {
						new Notice(
							t("notice.error", {
								what: t("settings.retention.name"),
								message: e instanceof Error ? e.message : String(e),
							}),
							8000,
						);
					}
				});
				void this.plugin.getRetention().then((days) => {
					this.retentionValue = String(days);
					text.setValue(this.retentionValue);
				});
			});

		new Setting(containerEl)
			.setName(t("settings.restore.name"))
			.setDesc(t("settings.restore.desc"))
			.addButton((b) =>
				b.setButtonText(t("settings.restore.button")).onClick(() => this.plugin.openRestore()),
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

	private renderState(containerEl: HTMLElement): void {
		const encrypting = this.plugin.encryptionReady();
		const locked = this.plugin.settings.encryption && !encrypting;
		const banner = containerEl.createDiv({
			cls: `lockstep-banner ${encrypting ? "is-safe" : locked ? "is-locked" : "is-open"}`,
		});
		const text = banner.createDiv({ cls: "lockstep-banner-text" });
		text.createDiv({
			cls: "lockstep-banner-title",
			text: encrypting
				? t(this.plugin.hidesNames() ? "banner.hiddenNames" : "banner.hidden")
				: locked
					? t("banner.locked")
					: t("banner.open"),
		});
		text.createDiv({
			cls: "lockstep-banner-detail",
			text: encrypting
				? t("encryption.explainHidden")
				: locked
					? `${this.plugin.encryptionStatus()} ${t("encryption.explainLocked")}`
					: t("encryption.explainNotHidden"),
		});
	}

	private renderConflicts(containerEl: HTMLElement): void {
		void this.plugin.pruneConflicts();
		const conflicts = this.plugin.index?.conflicts ?? [];
		if (conflicts.length === 0) return;

		new Setting(containerEl).setName(t("conflict.title")).setHeading();
		containerEl.createEl("p", { cls: "setting-item-description", text: t("conflict.intro") });

		for (const c of conflicts) {
			const setting = new Setting(containerEl)
				.setName(c.path)
				.setDesc(
					t("conflict.detail", {
						device: c.device,
						other: c.server_device || t("conflict.serverFallback"),
						when: new Date(c.at).toLocaleString(),
					}),
				);

			const decide = async (choice: "mine" | "server" | "merged") => {
				try {
					await this.plugin.resolveConflict(c.path, choice);
					new Notice(t("conflict.resolved", { path: c.path }));
				} catch (e) {
					new Notice(
						t("notice.error", {
							what: t("conflict.title"),
							message: e instanceof Error ? e.message : String(e),
						}),
						8000,
					);
				}
				this.display();
			};

			if (c.mergeable) {
				setting.addButton((b) =>
					b
						.setCta()
						.setButtonText(t("conflict.keepBoth"))
						.setTooltip(t("conflict.keepBoth.tooltip"))
						.onClick(() => void decide("merged")),
				);
			}
			setting.addButton((b) =>
				b
					.setButtonText(t("conflict.keepMine", { device: c.device }))
					.onClick(() => void decide("mine")),
			);
			setting.addButton((b) =>
				b.setButtonText(otherSideLabel(c)).onClick(() => void decide("server")),
			);
		}
	}
}
