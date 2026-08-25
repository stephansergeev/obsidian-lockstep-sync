// SPDX-License-Identifier: MIT

import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { t } from "./i18n";
import type { PendingConflict } from "./index-store";

/**
 * The list of files both sides changed, and the choice for each.
 *
 * Nothing here is a blocking prompt. On a phone the sync often finishes while the
 * app is being suspended, and a modal that must be answered right then would be
 * answered at random. The conflicts wait in a queue instead, and both versions sit
 * on disk until somebody opens this.
 */
export class ConflictModal extends Modal {
	constructor(
		app: App,
		private conflicts: () => PendingConflict[],
		private resolve: (path: string, choice: "mine" | "server" | "merged") => Promise<void>,
	) {
		super(app);
	}

	override onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const list = this.conflicts();

		new Setting(contentEl).setName(t("conflict.title")).setHeading();

		if (list.length === 0) {
			contentEl.createEl("p", { text: t("conflict.none") });
			return;
		}

		contentEl.createEl("p", { text: t("conflict.intro"), cls: "setting-item-description" });

		for (const c of list) {
			const box = contentEl.createDiv({ cls: "setting-item" });
			const info = box.createDiv({ cls: "setting-item-info" });
			info.createDiv({ cls: "setting-item-name", text: c.path });
			info.createDiv({
				cls: "setting-item-description",
				text: t("conflict.detail", {
					device: c.device,
					other: c.server_device || t("conflict.serverFallback"),
					when: new Date(c.at).toLocaleString(),
				}),
			});

			const links = box.createDiv({ cls: "setting-item-description" });
			this.link(
				links,
				t("conflict.openServer", { device: c.server_device || t("conflict.serverFallback") }),
				c.path,
			);
			links.createSpan({ text: "  ·  " });
			this.link(links, t("conflict.openMine", { device: c.device }), c.copy);

			// Keeping everything comes first and is the highlighted one. It is the only
			// choice that cannot lose a word, so it should be the easy thing to pick
			// when someone is deciding quickly on a phone.
			const row = new Setting(contentEl);
			// Binary content and very large files have no line-by-line merge, so the
			// option is not offered rather than offered and then refused.
			if (c.mergeable) {
				row.addButton((b) =>
					b
						.setCta()
						.setButtonText(t("conflict.keepBoth"))
						.setTooltip(t("conflict.keepBoth.tooltip"))
						.onClick(() => void this.choose(c.path, "merged")),
				);
			} else {
				info.createDiv({
					cls: "setting-item-description",
					text: t("conflict.notMergeable"),
				});
			}
			row
				.addButton((b) =>
					b
						.setButtonText(t("conflict.keepMine", { device: c.device }))
						.setTooltip(t("conflict.keepMine.tooltip"))
						.onClick(() => void this.choose(c.path, "mine")),
				)
				.addButton((b) =>
					b
						.setButtonText(t("conflict.keepServer"))
						.setTooltip(t("conflict.keepServer.tooltip"))
						.onClick(() => void this.choose(c.path, "server")),
				);
		}
	}

	private link(parent: HTMLElement, label: string, path: string): void {
		const a = parent.createEl("a", { text: label, href: "#" });
		a.addEventListener("click", (e) => {
			e.preventDefault();
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				void this.app.workspace.getLeaf(true).openFile(file);
				this.close();
			} else {
				new Notice(t("conflict.gone", { path }));
			}
		});
	}

	private async choose(path: string, choice: "mine" | "server" | "merged"): Promise<void> {
		try {
			await this.resolve(path, choice);
			new Notice(t("conflict.resolved", { path }));
		} catch (e) {
			new Notice(
				t("notice.error", {
					what: t("conflict.title"),
					message: e instanceof Error ? e.message : String(e),
				}),
				8000,
			);
		}
		this.render();
	}
}
