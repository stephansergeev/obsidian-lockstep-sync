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

		contentEl.createEl("h2", { text: t("conflict.title") });

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
					when: new Date(c.at).toLocaleString(),
				}),
			});

			const links = box.createDiv({ cls: "setting-item-description" });
			this.link(links, t("conflict.openServer"), c.path);
			links.createSpan({ text: "  ·  " });
			this.link(links, t("conflict.openMine", { device: c.device }), c.copy);

			new Setting(contentEl)
				.addButton((b) =>
					b
						.setButtonText(t("conflict.keepMine", { device: c.device }))
						.onClick(() => void this.choose(c.path, "mine")),
				)
				.addButton((b) =>
					b.setButtonText(t("conflict.keepServer")).onClick(() => void this.choose(c.path, "server")),
				)
				.addButton((b) =>
					b
						.setButtonText(t("conflict.keepMerged"))
						.setTooltip(t("conflict.keepMerged.tooltip"))
						.onClick(() => void this.choose(c.path, "merged")),
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
