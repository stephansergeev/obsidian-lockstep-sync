// Bundles the pure modules so node --test can import them without a TypeScript loader.
import esbuild from "esbuild";

await esbuild.build({
	entryPoints: ["src/diff3.ts", "src/crypto.ts", "src/sync-engine.ts", "src/index-store.ts"],
	bundle: true,
	format: "esm",
	target: "es2022",
	platform: "node",
	outdir: "test",
	// The engine only needs requestUrl at runtime, so the host is stubbed rather
	// than mocked: the code under test is the code that ships.
	alias: { obsidian: "./test/harness/obsidian-stub.mjs" },
	entryNames: "_[name]",
	outExtension: { ".js": ".mjs" },
	logLevel: "warning",
});
