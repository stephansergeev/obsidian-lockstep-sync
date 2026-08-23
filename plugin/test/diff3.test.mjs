// The merge is the one place in this project where text can be destroyed.
// Every test below checks the same invariant the server harness checks:
// NO LINE THAT SOMEONE WROTE DISAPPEARS QUIETLY.
import test from "node:test";
import assert from "node:assert/strict";
import { merge3, splitLines } from "./_diff3.mjs";

const base = "one\ntwo\nthree\nfour\n";

test("edits in different places merge without a decision", () => {
	const mine = "ONE\ntwo\nthree\nfour\n";
	const theirs = "one\ntwo\nthree\nFOUR\n";
	const r = merge3(base, mine, theirs);
	assert.equal(r.clean, true);
	assert.equal(r.text, "ONE\ntwo\nthree\nFOUR\n");
});

test("the same edit from both sides is not a conflict", () => {
	const both = "one\ntwo\nCHANGED\nfour\n";
	const r = merge3(base, both, both);
	assert.equal(r.clean, true);
	assert.equal(r.text, both);
});

test("one side untouched keeps the other side whole", () => {
	const theirs = "one\ntwo\nthree\nfour\nfive\n";
	assert.equal(merge3(base, base, theirs).text, theirs);
	assert.equal(merge3(base, theirs, base).text, theirs);
});

test("the same line edited differently conflicts and keeps both texts", () => {
	const mine = "one\nfrom the phone\nthree\nfour\n";
	const theirs = "one\nfrom the desktop\nthree\nfour\n";
	const r = merge3(base, mine, theirs, "iphone", "desk");
	assert.equal(r.clean, false);
	assert.equal(r.conflicts, 1);
	assert.match(r.text, /%% lockstep: iphone %%/);
	assert.match(r.text, /from the phone/);
	assert.match(r.text, /%% lockstep: desk %%/);
	assert.match(r.text, /from the desktop/);
	assert.match(r.text, /%% lockstep: end %%/);
	// Markers must not be markdown. A line of "=" makes a heading and a line
	// starting with ">" makes a blockquote, both of which wreck the note.
	for (const line of r.text.split("\n")) {
		assert.ok(!/^=+$/.test(line), `line ${JSON.stringify(line)} renders as a heading`);
		assert.ok(!/^>/.test(line), `line ${JSON.stringify(line)} renders as a quote`);
	}
});

test("insertions at different points both survive", () => {
	const mine = "one\nmine\ntwo\nthree\nfour\n";
	const theirs = "one\ntwo\nthree\ntheirs\nfour\n";
	const r = merge3(base, mine, theirs);
	assert.equal(r.clean, true);
	assert.match(r.text, /mine/);
	assert.match(r.text, /theirs/);
});

test("a deletion on one side and an edit elsewhere both apply", () => {
	const mine = "one\nthree\nfour\n";
	const theirs = "one\ntwo\nthree\nFOUR\n";
	const r = merge3(base, mine, theirs);
	assert.equal(r.clean, true);
	assert.equal(r.text.includes("two"), false);
	assert.match(r.text, /FOUR/);
});

test("the same deletion from both sides is not a conflict", () => {
	const cut = "one\nthree\nfour\n";
	const r = merge3(base, cut, cut);
	assert.equal(r.clean, true);
	assert.equal(r.text, cut);
});

test("deleting a line one side edited is a conflict, not a silent loss", () => {
	const mine = "one\nthree\nfour\n";
	const theirs = "one\nrewritten\nthree\nfour\n";
	const r = merge3(base, mine, theirs);
	assert.equal(r.clean, false);
	assert.match(r.text, /rewritten/);
});

test("two files created from nothing with different text conflict", () => {
	const r = merge3("", "mine\n", "theirs\n");
	assert.equal(r.clean, false);
	assert.match(r.text, /mine/);
	assert.match(r.text, /theirs/);
});

test("a trailing newline survives the round trip", () => {
	assert.equal(merge3("a\n", "a\n", "a\nb\n").text.endsWith("\n"), true);
	assert.equal(merge3("a", "a", "a\nb").text.endsWith("\n"), false);
});

test("no line unique to either side is ever dropped", () => {
	const cases = [
		["a\nb\nc\n", "a\nX\nb\nc\n", "a\nb\nY\nc\n"],
		["a\nb\nc\nd\n", "a\nc\nd\n", "a\nb\nc\nZ\n"],
		["", "one\ntwo\n", "three\n"],
		["a\n", "", "a\nb\n"],
		["x\ny\nz\n", "x\nQ\nz\n", "x\nW\nz\n"],
	];
	for (const [b, mine, theirs] of cases) {
		const r = merge3(b, mine, theirs);
		const produced = new Set(splitLines(r.text));
		const baseLines = new Set(splitLines(b));
		for (const side of [mine, theirs]) {
			for (const line of splitLines(side)) {
				if (baseLines.has(line)) continue; // a line kept from the base may be deleted
				assert.ok(
					produced.has(line),
					`line ${JSON.stringify(line)} vanished merging ${JSON.stringify(mine)} with ${JSON.stringify(theirs)} over ${JSON.stringify(b)}`,
				);
			}
		}
	}
});

test("a large file merges in reasonable time", () => {
	const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
	const b = lines.join("\n") + "\n";
	const mine = lines.map((l, i) => (i === 10 ? "mine" : l)).join("\n") + "\n";
	const theirs = lines.map((l, i) => (i === 4990 ? "theirs" : l)).join("\n") + "\n";
	const started = Date.now();
	const r = merge3(b, mine, theirs);
	assert.equal(r.clean, true);
	assert.ok(Date.now() - started < 5000, "merge took too long");
});

test("markers stay inside a callout instead of cutting it in half", () => {
	const base = "> [!note] Plan\n> one\n> two\n";
	const mine = "> [!note] Plan\n> from the phone\n> two\n";
	const theirs = "> [!note] Plan\n> from the desktop\n> two\n";
	const r = merge3(base, mine, theirs, "phone", "server");
	assert.equal(r.clean, false);
	for (const line of r.text.split("\n")) {
		if (line === "") continue;
		// Every line of the region has to keep continuing the callout, markers included.
		assert.match(line, /^>/, `line ${JSON.stringify(line)} breaks out of the callout`);
	}
	assert.match(r.text, /> %% lockstep: phone %%/);
});

test("markers never render as headings, rules or quotes on their own", () => {
	const r = merge3("a\nb\nc\n", "a\nMINE\nc\n", "a\nTHEIRS\nc\n");
	for (const line of r.text.split("\n")) {
		assert.ok(!/^=+$/.test(line), "a line of = renders as a heading");
		assert.ok(!/^-{3,}$/.test(line), "a line of - renders as a heading or frontmatter");
		assert.ok(!/^>/.test(line), "a line starting with > renders as a quote");
	}
	assert.match(r.text, /^%% lockstep: local %%$/m);
});
