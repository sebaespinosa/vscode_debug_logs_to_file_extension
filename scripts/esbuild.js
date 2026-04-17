const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * Two entry points with different externals:
 * - extension.ts runs inside VS Code's extension host; `vscode` is provided at runtime
 *   and MUST NOT be bundled.
 * - mcpServer.ts runs as a standalone Node child process; bundle all its dependencies.
 */
const baseOptions = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2022",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

const entries = [
  {
    ...baseOptions,
    entryPoints: ["src/extension.ts"],
    outfile: "out/extension.js",
    external: ["vscode"],
  },
  {
    ...baseOptions,
    entryPoints: ["src/mcpServer.ts"],
    outfile: "out/mcpServer.js",
  },
];

async function main() {
  if (watch) {
    const ctxs = await Promise.all(entries.map((e) => esbuild.context(e)));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log("[esbuild] watching…");
  } else {
    await Promise.all(entries.map((e) => esbuild.build(e)));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
