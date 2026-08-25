// SPDX-License-Identifier: MIT

import { App, Modal, Notice, Setting } from "obsidian";
import type { DeletedFile } from "./api";
import { t } from "./i18n";

/**
 * What is gone but not lost.
 *
 * Every revision of every file has been kept from the first version of this plugin,
 * and a deletion has always been a tombstone rather than an erasure. None of that
 * was reachable without a terminal, which meant a promise nobody could act on.
 */
export class RestoreModal extends Modal {
	private files: DeletedFile[] = [];
	private loading = true;

	constructor(
		app: App,
		private load: () => Promise<DeletedFile[]>,
		private restore: (file: DeletedFile) => Promise<void>,
	) {
		super(app);
	}

	override onOpen(): void {
		this.render();
		void this.refresh();
	}

	private async refresh(): Promise<void> {
		try {
			this.files = await this.load();
		} catch (e) {
			this.files = [];
			new Notice(
				t("notice.error", {
					what: t("restore.title"),
					message: e instanceof Error ? e.message : String(e),
				}),
				8000,
			);
		}
		this.loading = false;
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		new Setting(contentEl).setName(t("restore.title")).setHeading();

		if (this.loading) {
			contentEl.createEl("p", { cls: "setting-item-description", text: t("restore.loading") });
			return;
		}
		if (this.files.length === 0) {
			contentEl.createEl("p", { cls: "setting-item-description", text: t("restore.none") });
			return;
		}

		contentEl.createEl("p", { cls: "setting-item-description", text: t("restore.intro") });

		for (const file of this.files) {
			new Setting(contentEl)
				.setName(file.path)
				.setDesc(t("restore.detail", { when: new Date(file.deleted_at).toLocaleString() }))
				.addButton((b) =>
					b
						.setCta()
						.setButtonText(t("restore.button"))
						.onClick(async () => {
							b.setDisabled(true);
							try {
								await this.restore(file);
								new Notice(t("restore.done", { path: file.path }));
								this.files = this.files.filter((f) => f.path !== file.path);
								this.render();
							} catch (e) {
								b.setDisabled(false);
								new Notice(
									t("notice.error", {
										what: t("restore.title"),
										message: e instanceof Error ? e.message : String(e),
									}),
									8000,
								);
							}
						}),
				);
		}
	}
}
