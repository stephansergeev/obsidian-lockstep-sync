// SPDX-License-Identifier: MIT

import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	type SettingDefinition,
	type SettingDefinitionItem,
} from "obsidian";
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

/**
 * What a fresh install leaves out. Window state differs per device and only
 * gets in the way, and it lives in the configuration folder, whatever that is called.
 */
export function defaultExcludes(configDir: string): string[] {
	return [`${configDir}/workspace.json`, `${configDir}/workspace-mobile.json`, ".trash/"];
}

export const DEFAULT_SETTINGS: SyncSettings = {
	serverUrl: "",
	token: "",
	deviceName: "",
	// Filled in at load from the vault's configuration folder; see defaultExcludes.
	excludes: [".trash/"],
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
 *
 * The tab is declared rather than drawn: Obsidian renders the definitions, indexes
 * their names for the settings search, and re-evaluates every `visible` predicate
 * on `update()`. Rows that are more than a field, the passphrase with its meter and
 * its button, the conflicts, the progress line, render themselves into the row the
 * framework hands them.
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

	override hide(): void {
		this.plugin.progressTargets = [];
		this.plugin.lastSummary = null;
	}

	override getControlValue(key: string): unknown {
		const settings = this.plugin.settings as unknown as Record<string, unknown>;
		if (key === "excludes") return this.plugin.settings.excludes.join("\n");
		return settings[key];
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings as unknown as Record<string, unknown>;
		if (key === "excludes") {
			this.plugin.settings.excludes = String(value)
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean);
		} else {
			settings[key] = typeof value === "string" ? value.trim() : value;
		}
		await this.plugin.saveSettings();
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		this.plugin.progressTargets = [];
		void this.plugin.pruneConflicts();
		if (this.plugin.serverLooksEmpty() === null) {
			// Not asked yet. Ask, and redraw when the answer changes what is shown.
			void this.plugin.refreshServerVault().then(() => this.update());
		}
		return [
			this.conflictsGroup(),
			this.initialSyncRow(),
			this.lastSummaryRow(),
			this.encryptionBanner(),
			this.passphraseRow(),
			{
				name: t("settings.addDevice.name"),
				desc: t("settings.addDevice.desc"),
				render: (setting) => {
					setting.addButton((b) =>
						b.setCta().setButtonText(t("settings.addDevice.button")).onClick(() => {
							this.plugin.openAddDevice();
						}),
					);
				},
			},
			{
				type: "group",
				heading: t("settings.section.more"),
				items: this.moreItems(),
			},
			{
				name: "",
				desc: this.plugin.statusLine(),
				searchable: false,
			},
		];
	}

	// --- decisions first ----------------------------------------------------------

	/**
	 * The first sync of an existing vault into an empty server is a decision, and it
	 * is the first thing on the screen until it has been made. Once the server holds
	 * anything the question no longer exists and neither does the block.
	 */
	private initialSyncRow(): SettingDefinition {
		const files = this.app.vault.getFiles().length;
		return {
			name: t("settings.initial.name"),
			desc: t("settings.initial.desc", { count: files }),
			visible: () =>
				this.plugin.serverLooksEmpty() === true &&
				!this.plugin.encryptionWanted() &&
				this.app.vault.getFiles().length > 0,
			render: (setting) => {
				setting.addButton((b) =>
					b
						.setCta()
						.setButtonText(t("settings.initial.button"))
						.onClick(() => {
							b.setDisabled(true);
							void (async () => {
								await this.plugin.syncNow();
								await this.plugin.refreshServerVault();
								this.update();
							})();
						}),
				);
				this.plugin.progressTargets.push(this.progressLine(setting));
			},
		};
	}

	/** Where the initial-sync block stood: if a sync just finished, say so there. */
	private lastSummaryRow(): SettingDefinition {
		return {
			name: "",
			searchable: false,
			visible: () =>
				this.plugin.lastSummary !== null &&
				!(this.plugin.serverLooksEmpty() === true && !this.plugin.encryptionWanted()),
			render: (setting) => {
				setting.settingEl.empty();
				setting.settingEl.addClass("lockstep-row-bare");
				setting.settingEl.createDiv({
					cls: "lockstep-progress is-done",
					text: this.plugin.lastSummary ?? "",
				});
			},
		};
	}

	private encryptionBanner(): SettingDefinition {
		return {
			name: "",
			searchable: false,
			render: (setting) => {
				const encrypting = this.plugin.encryptionReady();
				const locked = this.plugin.isLocked();
				const elsewhere = this.plugin.migrationElsewhere();
				setting.settingEl.empty();
				setting.settingEl.addClass("lockstep-row-bare");
				const state = setting.settingEl.createDiv({
					cls: `lockstep-banner ${encrypting ? "is-safe" : locked ? "is-locked" : "is-open"}`,
				});
				state.createDiv({ cls: "lockstep-banner-text" }).createDiv({
					cls: "lockstep-banner-title",
					text: elsewhere
						? t("banner.encrypting", { device: elsewhere })
						: encrypting
							? t(this.plugin.hidesNames() ? "banner.hiddenNames" : "banner.hidden")
							: locked
								? t("banner.locked")
								: t("banner.open"),
				});
			},
		};
	}

	/**
	 * The passphrase and whichever button belongs beside it: Set on a fresh vault,
	 * Encrypt everything on a readable one, Continue on an interrupted migration,
	 * Unlock on a device joining an encrypted vault. Enter presses that button.
	 */
	private passphraseRow(): SettingDefinition {
		const fresh = this.plugin.vaultNeedsSetup();
		const resumable = this.plugin.migrationHere();
		// No key yet and files already on the server: setting the passphrase means
		// re-uploading them hidden, and the description has to say so before the press.
		const occupied = fresh && this.plugin.serverLooksEmpty() === false;
		return {
			name: t("settings.encrypt.name"),
			desc: t(
				fresh
					? occupied
						? "settings.encrypt.descMigrate"
						: "settings.encrypt.descNew"
					: resumable
						? "settings.encrypt.descResume"
						: "settings.encrypt.descExisting",
			),
			aliases: ["passphrase", "encryption", "password"],
			render: (setting) => this.renderPassphrase(setting, fresh, resumable, occupied),
		};
	}

	private renderPassphrase(
		row: Setting,
		fresh: boolean,
		resumable: boolean,
		occupied: boolean,
	): void {
		const encrypting = this.plugin.encryptionReady();
		const elsewhere = this.plugin.migrationElsewhere();

		row.settingEl.addClass("lockstep-row-stacked");
		const meter = row.settingEl.createDiv({ cls: "lockstep-meter" });
		const bar = meter.createDiv({ cls: "lockstep-meter-bar" });
		const segments = [0, 1, 2].map(() => bar.createDiv({ cls: "lockstep-meter-segment" }));
		const label = meter.createDiv({ cls: "lockstep-meter-label" });
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

		row.addText((text) => {
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
				.onChange((v) => {
					this.plugin.settings.passphrase = v;
					void this.plugin.saveSettings();
					judge(v);
				});
			judge(this.plugin.settings.passphrase);
			text.inputEl.addEventListener("blur", () => {
				void (async () => {
					// Unlocking an existing vault is safe to try on blur: a fragment
					// gives a wrong-passphrase notice and nothing more. Creating a key
					// is not, and waits for the button.
					try {
						await this.plugin.applyEncryption();
					} catch {
						/* already reported */
					}
					this.update();
				})();
			});
		});

		const press = async (run: () => Promise<void>) => {
			try {
				await run();
			} catch {
				/* already reported */
			}
			this.update();
		};
		if (fresh) {
			row.addButton((b) =>
				b
					.setCta()
					.setButtonText(t(occupied ? "settings.encrypt.migrate" : "settings.encrypt.set"))
					.setTooltip(t("settings.encrypt.setTip"))
					.onClick(() => {
						b.setDisabled(true);
						// Creates the key and starts the sync, or the re-upload; progress
						// lands below.
						void press(() => this.plugin.applyEncryption(false, true));
					}),
			);
		} else if (resumable) {
			row.addButton((b) =>
				b
					.setCta()
					.setButtonText(t("settings.encrypt.resume"))
					.onClick(() => {
						b.setDisabled(true);
						void press(() => this.plugin.encryptInPlace(false));
					}),
			);
		} else if (!encrypting && !elsewhere) {
			// A vault that already has a key, on a device that has not opened it: the
			// second device, typing the passphrase it was told. Leaving the field used
			// to be the trigger, which on a phone is nothing anybody does on purpose.
			row.addButton((b) =>
				b
					.setCta()
					.setButtonText(t("settings.encrypt.unlock"))
					.onClick(() => {
						b.setDisabled(true);
						void press(() => this.plugin.applyEncryption(false));
					}),
			);
		}
		// Enter in the field presses whichever button stands beside it.
		const field = row.controlEl.querySelector("input");
		const button = row.controlEl.querySelector("button");
		if (field && button) {
			field.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter") {
					ev.preventDefault();
					button.click();
				}
			});
		}
		if (fresh || resumable || (!encrypting && !elsewhere)) {
			this.plugin.progressTargets.push(this.progressLine(row));
		}
	}

	/** A line under a row where a sync in progress writes its percentage. */
	private progressLine(row: Setting): HTMLElement {
		row.settingEl.addClass("lockstep-row-stacked");
		return row.settingEl.createDiv({ cls: "lockstep-progress" });
	}

	// --- everything typed once and rarely again, most-touched first --------------

	private moreItems(): SettingDefinition[] {
		return [
			{
				name: t("settings.restore.name"),
				desc: t("settings.restore.desc"),
				render: (setting) => {
					setting.addButton((b) =>
						b.setButtonText(t("settings.restore.button")).onClick(() => this.plugin.openRestore()),
					);
				},
			},
			{
				name: t("settings.retention.name"),
				desc: t("settings.retention.desc"),
				// Lives on the server, not in the settings file, so it is a render row.
				render: (setting) => this.renderRetention(setting),
			},
			{
				name: t("settings.serverUrl.name"),
				desc: t("settings.serverUrl.desc"),
				control: { type: "text", key: "serverUrl", placeholder: "https://sync.example.com" },
			},
			{
				name: t("settings.token.name"),
				desc: t("settings.token.desc"),
				// A password field, which the text control does not offer.
				render: (setting) => {
					setting.addText((text) => {
						text.inputEl.type = "password";
						text
							.setPlaceholder("obs_…")
							.setValue(this.plugin.settings.token)
							.onChange((v) => {
								this.plugin.settings.token = v.trim();
								void this.plugin.saveSettings();
							});
					});
				},
			},
			{
				// Which vault on the server this token opens. What the vault is called in
				// Obsidian is local to this device and travels nowhere.
				name: t("settings.serverVault.name"),
				desc: t("settings.serverVault.desc"),
				render: (setting) => {
					const value = setting.controlEl.createSpan({
						cls: "lockstep-vault-name",
						text: this.plugin.serverVaultName() || t("settings.serverVault.unknown"),
					});
					void this.plugin.refreshServerVault().then(() => {
						value.setText(this.plugin.serverVaultName() || t("settings.serverVault.unknown"));
					});
				},
			},
			{
				name: t("settings.device.name"),
				desc: t("settings.device.desc"),
				control: { type: "text", key: "deviceName", placeholder: defaultDeviceName() },
			},
			{
				name: t("settings.excludes.name"),
				desc: t("settings.excludes.desc"),
				control: { type: "textarea", key: "excludes" },
			},
		];
	}

	private renderRetention(setting: Setting): void {
		setting.addText((text) => {
			text.inputEl.type = "number";
			text.inputEl.min = "0";
			text.inputEl.max = "3650";
			text.setPlaceholder("30").setValue(this.retentionValue);
			text.inputEl.addEventListener("blur", () => {
				void (async () => {
					const days = Number(text.getValue());
					if (!Number.isFinite(days) || days < 0 || days > 3650) return;
					try {
						await this.plugin.setRetention(days);
						this.retentionValue = String(days);
						new Notice(
							days === 0 ? t("settings.retention.forever") : t("settings.retention.saved", { days }),
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
				})();
			});
			void this.plugin.getRetention().then((days) => {
				this.retentionValue = String(days);
				text.setValue(this.retentionValue);
			});
		});
	}

	// --- conflicts, when there are any --------------------------------------------

	private conflictsGroup(): SettingDefinitionItem {
		const conflicts = this.plugin.index?.conflicts ?? [];
		return {
			type: "group",
			heading: t("conflict.title"),
			visible: () => (this.plugin.index?.conflicts ?? []).length > 0,
			items: [
				{ name: "", desc: t("conflict.intro"), searchable: false },
				...conflicts.map(
					(c): SettingDefinition => ({
						name: c.path,
						desc: t("conflict.detail", {
							device: c.device,
							other: c.server_device || t("conflict.serverFallback"),
							when: new Date(c.at).toLocaleString(),
						}),
						searchable: false,
						render: (setting) => {
							const decide = (choice: "mine" | "server" | "merged") => {
								void (async () => {
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
									this.update();
								})();
							};
							if (c.mergeable) {
								setting.addButton((b) =>
									b
										.setCta()
										.setButtonText(t("conflict.keepBoth"))
										.setTooltip(t("conflict.keepBoth.tooltip"))
										.onClick(() => decide("merged")),
								);
							}
							setting.addButton((b) =>
								b
									.setButtonText(t("conflict.keepMine", { device: c.device }))
									.onClick(() => decide("mine")),
							);
							setting.addButton((b) =>
								b.setButtonText(otherSideLabel(c)).onClick(() => decide("server")),
							);
						},
					}),
				),
			],
		};
	}
}
