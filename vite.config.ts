import { defineConfig } from "vite";

/**
 * One output, deliberately.
 *
 * An IIFE with React bundled in is the only form that satisfies all three ways
 * this gets used: a <script> tag in a project that has never heard of React, a
 * bookmarklet on a page nobody controls, and a devDependency in a project that
 * does have React. The usual objection to bundling React — two copies fighting
 * over context and hooks — doesn't apply here, because the overlay owns its own
 * createRoot and shares no tree with whatever it's dropped into.
 *
 * Splitting this into an ESM build with React externalised would mean two build
 * passes and two sets of instructions to keep straight, to save ~45kb on a tool
 * that only ever runs on a developer's own machine.
 */
export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      name: "DevStudio",
      formats: ["iife"],
      fileName: () => "devstudio.js",
    },
    // Nothing external: see above.
    rollupOptions: {},
    // The stylesheet is imported with ?inline and injected at runtime, so the
    // bundle stays a single file — a bookmarklet has nowhere to put a sidecar
    // .css, and a script tag shouldn't need a second one.
    cssCodeSplit: false,
    minify: "esbuild",
    target: "es2020",
    emptyOutDir: true,
  },
  define: {
    // React reads this and throws on an undefined `process` in a bare browser.
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});
