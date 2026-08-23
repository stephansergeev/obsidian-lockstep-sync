// Bundles the pure modules so node --test can import them without a TypeScript loader.
import esbuild from "esbuild";

await esbuild.build({
	entryPoints: ["src/diff3.ts"],
	bundle: true,
	format: "esm",
	target: "es2022",
	platform: "node",
	outfile: "test/_diff3.mjs",
	logLevel: "warning",
});
