// SPDX-License-Identifier: MIT

import { Notice } from "obsidian";
import { t } from "./i18n";
import type { PendingConflict } from "./index-store";

export type ConflictChoice = "mine" | "server" | "merged";

/**
 * Offer the choice where the person already is: in the notice itself.
 *
 * Sending somebody to a settings screen to answer a one-line question is how a
 * decision turns into a chore and a conflict copy turns into permanent clutter. The
 * notice stays until it is answered or dismissed, and the same conflict remains in
 * the list either way, so nothing is lost by ignoring it.
 */
export function showConflictNotice(
	conflict: PendingConflict,
	resolve: (choice: ConflictChoice) => Promise<void>,
): void {
	// Zero means it stays put. A question that vanishes after five seconds is a
	// question nobody answers.
	const notice = new Notice("", 0);
	const el = notice.noticeEl;
	el.empty();
	el.addClass("lockstep-conflict-notice");

	el.createDiv({ text: t("notice.conflictQueued", { path: conflict.path }) });

	const row = el.createDiv();
	row.style.display = "flex";
	row.style.flexWrap = "wrap";
	row.style.gap = "6px";
	row.style.marginTop = "10px";

	const button = (label: string, choice: ConflictChoice, primary = false) => {
		const b = row.createEl("button", { text: label });
		b.style.flex = "1 1 auto";
		if (primary) b.addClass("mod-cta");
		b.addEventListener("click", (e) => {
			// Clicking anywhere on a notice dismisses it, so the button has to keep the
			// click to itself or the answer is lost along with the notice.
			e.stopPropagation();
			b.disabled = true;
			void resolve(choice)
				.then(() => notice.hide())
				.catch(() => {
					b.disabled = false;
				});
		});
	};

	if (conflict.mergeable) button(t("conflict.keepBoth"), "merged", true);
	button(t("conflict.keepMine", { device: conflict.device }), "mine");
	button(t("conflict.keepServer"), "server");
}
