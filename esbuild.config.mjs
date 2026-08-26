import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // node 内置模块保留 require（同步服务用 http/crypto，渲染进程由 Obsidian 提供）；
  // 参考 Local REST API 等社区插件的做法
  external: ["obsidian", "electron", "http", "crypto", "os", "dgram", "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language", "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view", "@lezer/common", "@lezer/highlight", "@lezer/lr"],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": prod ? '"production"' : '"development"' },
  minify: prod,
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
