import solidPlugin from "@opentui/solid/bun-plugin";

await Bun.build({
  entrypoints: ["./src/index.tsx"],
  target: "bun",
  outdir: "./dist",
  conditions: ["browser"],
  alias: { "solid-js": "solid-js/dist/solid.js" },
  external: ["@opentui/core"],
  plugins: [solidPlugin],
});
