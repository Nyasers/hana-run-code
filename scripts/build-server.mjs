// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/build-server.mjs — 把服务端代码打成单入口 bundle（dist/bin/app.mjs）。
 *
 * ## 为什么打 bundle
 *
 * 交付面是「装到机器上要跑的东西」，不是「源码树的形状」。源码是 src/ 下四个文件，产物则是
 * 宿主读取的一个入口文件——两边的形状不同不是不一致，是各自回答自己的问题：源树回答
 * 「代码属于谁」，产物回答「宿主该加载什么」。
 *
 * 打成一个文件还消掉了一整类问题：相对 import 路径在产物里必须改写，而手写改写脚本只是
 * 在用字符串替换模拟一个打包器；打包器直接把这些边连上，不留改写规则。
 *
 * ## 交付树形状
 *
 *   manifest.json   App v2 契约件
 *   icon.svg        身份图标（manifest.icon 指向的包内真实图片）
 *   bin/app.mjs     单入口（manifest.entry）
 *
 * 产物里不含 package.json：`.mjs` 扩展名自带 ESM 语义，Node 按扩展名就判 ESM。
 *
 * ## 为什么 externalsPresets.node
 *
 * node: 内置模块（fs / child_process / crypto / path …）是宿主进程提供的，不该被打进来。
 * 本 App 零第三方运行时依赖——@rspack/core 是构建期 devDependency，不进交付树。
 *
 * ## import.meta.url 不固化
 *
 * 默认行为会把 `import.meta.url` 在构建期替换成构建机的绝对路径。本 App 的
 * lib/run.mjs 用 process.execPath 定位 node，不依赖 import.meta.url，但保留运行时语义
 * 仍是对的：一旦将来有代码靠它定位安装根，固化就成了「在我机器上能跑」的坑。
 *
 * 用法：node scripts/build-server.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rspack } from "@rspack/core";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "src/app.mjs");
const OUT_DIR = path.join(ROOT, "dist", "bin");

if (!fs.existsSync(ENTRY)) {
  console.error("[build-server] 入口不存在：" + ENTRY);
  process.exit(1);
}

const config = {
  mode: "production",
  devtool: false,
  target: "node",
  entry: { app: ENTRY },
  output: {
    path: OUT_DIR,
    filename: "[name].mjs",
    clean: false, // dist/bin 由 build-app 统一清理，这里不抢
    module: true,
    chunkFormat: "module",
    library: { type: "module" },
  },
  experiments: { outputModule: true },
  // node 内置模块全部外部化：它们是宿主进程提供的，不该打进产物。
  externalsPresets: { node: true },
  module: {
    parser: {
      javascript: {
        // 不要把 import.meta.url 在构建期固化成构建机的绝对路径。
        importMeta: false,
      },
    },
  },
  optimization: {
    // 不切 chunk：单入口、没有动态 import，没有可切的东西。
    // 单入口还有个真好处：产物逐字节可复现（连跑两次 SHA256 相同），宿主缓存它才稳。
    splitChunks: false,
    runtimeChunk: false,
    minimize: true,
  },
  resolve: { extensions: [".mjs", ".js", ".json"] },
  performance: { hints: false },
  stats: "errors-warnings",
};

rspack(config, (err, stats) => {
  if (err) {
    console.error("[build-server] 编译失败：" + (err.message || err));
    process.exit(1);
  }
  const info = stats.toJson({ all: false, assets: true, errors: true, warnings: true });
  for (const w of info.warnings || []) {
    console.log("[build-server] 警告: " + (w.message || "").split("\n")[0]);
  }
  if (stats.hasErrors()) {
    for (const e of info.errors || []) console.error("[build-server] 错误: " + e.message);
    process.exit(1);
  }
  const out = path.join(OUT_DIR, "app.mjs");
  if (!fs.existsSync(out)) {
    console.error("[build-server] 未产出 dist/bin/app.mjs");
    process.exit(1);
  }
  const kb = (n) => (n / 1024).toFixed(1) + " KB";
  console.log("[build-server] dist/bin/app.mjs  " + kb(fs.statSync(out).size) + "（单入口 ESM）");
});
