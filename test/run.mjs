// SPDX-License-Identifier: MIT
//
// Runs the test files across node versions without a version-specific flag in
// package.json. Process isolation is the test runner's default from node 24 and
// hangs this harness on some filesystems (each test spawns a server child), so it
// is turned off where the flag exists. Node 20-23 have no isolation default and
// reject the flag outright, so they get nothing. One npm script, every node.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const major = Number(process.versions.node.split(".")[0]);
const files = readdirSync("test")
	.filter((f) => f.endsWith(".test.mjs"))
	.map((f) => `test/${f}`);
const args = ["--test", ...(major >= 24 ? ["--test-isolation=none"] : []), ...files];
const run = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(run.status ?? 1);
