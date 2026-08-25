// SPDX-License-Identifier: MIT

import qrcode from "qrcode-generator";

/**
 * Draw a setup link as a QR code.
 *
 * A link still has to be sent somewhere and opened, which means a messenger, a
 * clipboard, and a token passing through both. A code on the screen skips all of
 * that: the other device points its camera at it and opens the link directly.
 *
 * Drawn as SVG rectangles rather than a canvas, because a canvas has to be sized in
 * device pixels to stay sharp and gets that wrong on a phone often enough to matter.
 */
export function renderQr(parent: HTMLElement, text: string, moduleSize = 6): void {
	// Version 0 lets the library pick the smallest that fits. Error correction M
	// survives a camera at an angle without making the code much denser.
	const qr = qrcode(0, "M");
	qr.addData(text);
	qr.make();

	const count = qr.getModuleCount();
	const quiet = 4; // the blank margin a scanner needs to find the edges
	const size = (count + quiet * 2) * moduleSize;

	const svg = parent.createSvg("svg", { cls: "lockstep-qr" });
	svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("role", "img");

	const bg = svg.createSvg("rect");
	bg.setAttribute("width", String(size));
	bg.setAttribute("height", String(size));
	bg.setAttribute("fill", "#ffffff");

	// One path of many rectangles: a thousand separate elements is slow to lay out.
	const parts: string[] = [];
	for (let row = 0; row < count; row++) {
		for (let col = 0; col < count; col++) {
			if (!qr.isDark(row, col)) continue;
			const x = (col + quiet) * moduleSize;
			const y = (row + quiet) * moduleSize;
			parts.push(`M${x} ${y}h${moduleSize}v${moduleSize}h-${moduleSize}z`);
		}
	}
	const path = svg.createSvg("path");
	path.setAttribute("d", parts.join(""));
	// Always black on white, whatever the theme is doing. A scanner needs contrast,
	// and a dark theme would otherwise invert the code into something unreadable.
	path.setAttribute("fill", "#000000");
}
