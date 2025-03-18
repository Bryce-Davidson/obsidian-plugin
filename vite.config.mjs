import { defineConfig } from "vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react";
import builtins from "builtin-modules";

export default defineConfig({
	css: {
		modules: {
			scopeBehaviour: "local",
			localsConvention: "camelCase",
		},
	},
	build: {
		lib: {
			entry: resolve(__dirname, "src/main.ts"),
			formats: ["cjs"],
			fileName: () => "main.js",
		},
		rollupOptions: {
			external: [
				"obsidian",
				"electron",
				"@codemirror/autocomplete",
				"@codemirror/collab",
				"@codemirror/commands",
				"@codemirror/language",
				"@codemirror/lint",
				"@codemirror/search",
				"@codemirror/state",
				"@codemirror/view",
				"@lezer/common",
				"@lezer/highlight",
				"@lezer/lr",
				...builtins,
			],
			output: {
				exports: "named",
				banner: `/*
THIS IS A GENERATED/BUNDLED FILE BY VITE
if you want to view the source, please visit the github repository of this plugin
*/`,
				entryFileNames: "main.js",
				sourcemap:
					process.env.NODE_ENV !== "production" ? "inline" : false,
				format: "cjs",
				assetFileNames: "styles.css",
				manualChunks: undefined,
			},
		},
		outDir: "./",
		emptyOutDir: false,
		sourcemap: process.env.NODE_ENV !== "production" ? "inline" : false,
		minify: process.env.NODE_ENV === "production",
		target: "esnext",
	},
	plugins: [react()],
});
