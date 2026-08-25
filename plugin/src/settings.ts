// SPDX-License-Identifier: MIT

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { otherSideLabel } from "./conflict-notice";
import { t } from "./i18n";
import { defaultDeviceName } from "./paths";
import { judgePassphrase } from "./crypto";
import type LockstepPlugin from "./main";

export interface SyncSettings {
	serverUrl: string;
	token: string;
	deviceName: string;
	/** Paths that never leave this device, whatever else is configured. */
	excludes: string[];
	/** Kept for old settings files; syncing is always automatic now. */
	autoSync: boolean;
	/** Kept for old settings files; a passphrase is the intent now. */
	encryption: boolean;
	/**
	 * The passphrase, kept in the plugin's own settings file inside the vault.
	 *
	 * That file sits on a device you already control, and the threat this encryption
	 * answers is the server, not your own laptop. Asking for a passphrase on every
	 * launch would mostly train people to turn encryption off.
	 */
	passphrase: string;
	/** Kept for old settings files; the interval itself is fixed in code now. */
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
	intervalSeconds: 15,
};

/**
 * The screen is ordered by what somebody needs to see, not by what the plugin is
 * made of. Decisions first, the three things a person acts on next, and every
 * setting that was typed once and never again at the bottom, in order of how often
 * it is likely to be touched.
 */
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

		this.renderConflicts(containerEl);
		this.renderInitialSync(containerEl);
		this.renderEncryption(containerEl);

		new Setting(containerEl)
			.setName(t("settings.addDevice.name"))
			.setDesc(t("settings.addDevice.desc"))
			.addButton((b) =>
				b.setCta().setButtonText(t("settings.addDevice.button")).onClick(() => {
					this.plugin.openAddDevice();
				}),
			);

		new Setting(containerEl).setName(t("settings.section.more")).setHeading();
		this.renderMore(containerEl);

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: this.plugin.statusLine(),
		});
	}

	/**
	 * The first sync of an existing vault into an empty server is a decision, and it
	 * is the first thing on the screen until it has been made. Once the server holds
	 * anything the question no longer exists and neither does the block.
	 */
	private renderInitialSync(containerEl: HTMLElement): void {
		const empty = this.plugin.serverLooksEmpty();
		if (empty === null) {
			void this.plugin.refreshServerVault().then(() => {
				if (this.plugin.serverLooksEmpty() === true) this.display();
			});
			return;
		}
		if (!empty || this.plugin.encryptionWanted() || this.app.vault.getFiles().length === 0) return;

		new Setting(containerEl)
			.setName(t("settings.initial.name"))
			.setDesc(t("settings.initial.desc", { count: this.app.vault.getFiles().length }))
			.addButton((b) =>
				b
					.setCta()
					.setButtonText(t("settings.initial.button"))
					.onClick(async () => {
						b.setDisabled(true);
						await this.plugin.syncNow();
						await this.plugin.refreshServerVault();
						this.display();
					}),
			);
	}

	private renderEncryption(containerEl: HTMLElement): void {
		const encrypting = this.plugin.encryptionReady();
		const locked = this.plugin.isLocked();
		const state = containerEl.createDiv({
			cls: `lockstep-banner ${encrypting ? "is-safe" : locked ? "is-locked" : "is-open"}`,
		});
		state.createDiv({ cls: "lockstep-banner-text" }).createDiv({
			cls: "lockstep-banner-title",
			text: encrypting
				? t(this.plugin.hidesNames() ? "banner.hiddenNames" : "banner.hidden")
				: locked
					? t("banner.locked")
					: t("banner.open"),
		});

		const meter = containerEl.createDiv({ cls: "lockstep-meter" });
		const bar = meter.createDiv({ cls: "lockstep-meter-bar" });
		const segments = [0, 1, 2].map(() => bar.createDiv({ cls: "lockstep-meter-segment" }));
		const label = meter.createDiv({ cls: "lockstep-meter-label" });
		const fresh = this.plugin.vaultNeedsSetup();

		const judge = (value: string) => {
			// Strength only matters while the passphrase is being chosen.
			meter.toggleClass("is-hidden", !value || !fresh);
			if (!value || !fresh) return;
			const verdict = judgePassphrase(value);
			const filled = verdict === "weak" ? 1 : verdict === "medium" ? 2 : 3;
			segments.forEach((seg, i) => {
				seg.removeClass("is-weak", "is-medium", "is-strong");
				if (i < filled) seg.addClass(`is-${verdict}`);
			});
			label.setText(t(`settings.passphrase.${verdict}`));
			label.removeClass("is-weak", "is-medium", "is-strong");
			label.addClass(`is-${verdict}`);
		};

		const row = new Setting(containerEl)
			.setName(t("settings.encrypt.name"))
			.setDesc(t(fresh ? "settings.encrypt.descNew" : "settings.encrypt.descExisting"))
			.addText((text) => {
				text.inputEl.type = "password";
				if (this.plugin.takeFocusRequest()) {
					window.setTimeout(() => {
						text.inputEl.focus();
						text.inputEl.scrollIntoView({ block: "center" });
					}, 50);
				}
				text
					.setPlaceholder(t("settings.encrypt.placeholder"))
					.setValue(this.plugin.settings.passphrase)
					.onChange(async (v) => {
						this.plugin.settings.passphrase = v;
						await this.plugin.saveSettings();
						judge(v);
					});
				judge(this.plugin.settings.passphrase);
				text.inputEl.addEventListener("blur", async () => {
					// Unlocking an existing vault is safe to try on blur: a fragment
					// gives a wrong-passphrase notice and nothing more. Creating a key
					// is not, and waits for the button.
					try {
						await this.plugin.applyEncryption();
					} catch {
						/* already reported */
					}
					this.display();
				});
			});

		if (fresh) {
			row.addButton((b) =>
				b
					.setCta()
					.setButtonText(t("settings.encrypt.set"))
					.setTooltip(t("settings.encrypt.setTip"))
					.onClick(async () => {
						b.setDisabled(true);
						try {
							await this.plugin.applyEncryption(false, true);
						} catch {
							/* already reported */
						}
						this.display();
					}),
			);
		}
	}

	/** Everything typed once and rarely again, most-touched first. */
	private renderMore(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t("settings.sync.name"))
			.setDesc(t("settings.sync.desc"))
			.addButton((b) =>
				b.setButtonText(t("settings.sync.button")).onClick(async () => {
					await this.plugin.syncNow();
				}),
			);

		new Setting(containerEl)
			.setName(t("settings.restore.name"))
			.setDesc(t("settings.restore.desc"))
			.addButton((b) =>
				b.setButtonText(t("settings.restore.button")).onClick(() => this.plugin.openRestore()),
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
		// Obsidian is local to this device and travels nowhere.
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
