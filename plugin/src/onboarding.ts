// SPDX-License-Identifier: MIT

import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "./i18n";
import { renderQr } from "./qr";

/**
 * Adding a second device.
 *
 * The old way was: open a terminal on the server, issue a token, get eighty
 * characters of it onto a phone somehow, type a URL, type a device name. Five steps
 * across three machines before anything syncs, and the point where most people stop.
 *
 * The new way is one link. It carries the address and a freshly minted token, opens
 * Obsidian on the other device and fills the settings in. The passphrase is
 * deliberately not in it: a link travels through messengers and clipboards, and the
 * one secret that makes the server unable to read the vault should not.
 */
export class AddDeviceModal extends Modal {
	private name = "";
	private link = "";

	constructor(
		app: App,
		private issue: (name: string) => Promise<string>,
		private encrypted: boolean,
		private serverUrl: string,
	) {
		super(app);
	}

	override onOpen(): void {
		this.name = "";
		this.link = "";
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		new Setting(contentEl).setName(t("add.title")).setHeading();

		if (!this.link) {
			contentEl.createEl("p", { cls: "setting-item-description", text: t("add.intro") });
			new Setting(contentEl)
				.setName(t("add.name"))
				.setDesc(t("add.nameDesc"))
				.addText((text) =>
					text.setPlaceholder("phone").onChange((v) => {
						this.name = v.trim();
					}),
				)
				.addButton((b) =>
					b
						.setCta()
						.setButtonText(t("add.create"))
						.onClick(async () => {
							if (!this.name) {
								new Notice(t("add.needName"));
								return;
							}
							b.setDisabled(true);
							try {
								this.link = await this.issue(this.name);
								this.render();
							} catch (e) {
								b.setDisabled(false);
								new Notice(
									t("notice.error", {
										what: t("add.title"),
										message: e instanceof Error ? e.message : String(e),
									}),
									8000,
								);
							}
						}),
				);
			return;
		}

		contentEl.createEl("p", { cls: "setting-item-description", text: t("add.ready") });

		// The code first, because pointing a camera at it is the shortest path there
		// is: no messenger, no clipboard, and the token never leaves this room.
		const frame = contentEl.createDiv({ cls: "lockstep-qr-frame" });
		try {
			renderQr(frame, this.link);
			frame.createDiv({ cls: "setting-item-description", text: t("add.scan") });
		} catch {
			frame.detach(); // the link below still works
		}

		// What is in the code, in words, beside the code itself. A QR is unreadable by
		// eye, and asking somebody to scan something they cannot read is the shape of
		// every phishing attempt they have been taught to refuse. The answer is not to
		// drop the code, it is to make it inspectable: this is the same link printed
		// below, and here is everything inside it.
		const what = contentEl.createDiv({ cls: "lockstep-contents" });
		what.createDiv({ cls: "lockstep-contents-title", text: t("add.contents") });
		const list = what.createEl("ul");
		list.createEl("li", { text: t("add.contentsUrl", { url: this.serverUrl }) });
		list.createEl("li", { text: t("add.contentsToken", { device: this.name }) });
		list.createEl("li", { text: t("add.contentsNothingElse") });

		contentEl.createEl("p", { cls: "setting-item-description", text: t("add.orLink") });

		const box = contentEl.createEl("textarea", { cls: "lockstep-setup-link" });
		box.value = this.link;
		box.readOnly = true;
		box.rows = 3;
		box.addEventListener("focus", () => box.select());
		box.addEventListener("click", () => box.select());

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setCta()
					.setButtonText(t("add.copy"))
					.onClick(async () => {
						try {
							await navigator.clipboard.writeText(this.link);
							new Notice(t("add.copied"));
						} catch {
							// Some contexts refuse the clipboard. Selecting it leaves the
							// person one keystroke away rather than stuck.
							box.focus();
							box.select();
							new Notice(t("add.copyManually"), 8000);
						}
					}),
			)
			.addButton((b) =>
				b.setButtonText(t("add.openHere")).setTooltip(t("add.openHereTip")).onClick(() => {
					window.open(this.link);
				}),
			);

		if (this.encrypted) {
			contentEl.createEl("p", {
				cls: "setting-item-description lockstep-warning",
				text: t("add.passphraseSeparately"),
			});
		}
	}
}
