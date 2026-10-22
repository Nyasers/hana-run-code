// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/build-app.mjs — 组装 App 交付树 dist/（= 安装目录形态）。
 *
 * ## 为什么要有这一层
 *
 * 直接从源码树过滤出包，等于「源码树里多出什么」就「包里多出什么」：本地笔记、规划
 * 文档、node_modules 都会跟着进包，而黑名单只列它记得的东西。所以改成白名单组装——
 * 源码树里多出什么都不影响包，要进包就必须在下面的名单里。
 *
 * ## dist/ 的形状
 *
 *   manifest.json   契约件（源在 src/manifest.json）
 *   icon.svg        身份图标（manifest.icon 指向它；源在 assets/）
 *   bin/app.mjs     单入口（由 build-server.mjs 打包产出）
 *
 * **服务端代码以单入口进包**：安装目录里只有一个 bin/app.mjs，而不是 src/ 下
 * 那份源码树的形状。交付面是「要跑的东西」，不是「代码怎么组织的」。
 *
 * 不含：scripts/（开发件）、src/（源码，已 bundle）、node_modules/（构建期依赖，
 * 运行期无消费者）、package.json（.mjs 自带 ESM 语义，不需要它跟包）。
 *
 * ## 每轮先清再写
 *
 * dist/ 是构建产出，每轮整体清空重建，避免上一轮的残留被当成产物。
 *
 * 用法：node scripts/build-app.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

/** 交付件白名单：**只有**列在这里的东西会进包。 */
const DELIVERY_FILES = ["manifest.json"];
/** 由构建脚本产出的文件（这里只断言它在位，不负责生成）。 */
const BUILT_FILES = ["bin/app.mjs"];

const log = (...a) => console.log("[build-app]", ...a);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");

function fatal(message) {
  console.error("[build-app] " + message);
  process.exit(1);
}

function main() {
  // 0) 清空重建：dist/ 是产出，每轮整体重来。
  //    必须在调构建脚本**之前**清：构建脚本直接写 dist/，清晚一步就把刚构好的产物抹掉。
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, "bin"), { recursive: true });

  // 1) 打单入口（依赖顺序：build-server 需要 src/ 源码就位）
  log("构建服务端单入口（src/app.mjs → dist/bin/app.mjs）…");
  try {
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-server.mjs")], {
      cwd: ROOT,
      stdio: "inherit",
    });
  } catch {
    fatal("服务端构建失败");
  }

  // 2) 契约件（白名单逐个点名）
  for (const name of DELIVERY_FILES) {
    const src = path.join(ROOT, "src", name);
    if (!fs.existsSync(src)) fatal("交付件缺失：src/" + name);
    fs.copyFileSync(src, path.join(DIST, name));
  }

  // 3) 身份图标：manifest.icon 是包根相对路径，源在 assets/
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8"));
  if (typeof manifest.icon !== "string" || !manifest.icon) {
    fatal("manifest.icon 未声明：App v2 必须有身份图标");
  }
  const iconSrc = path.join(ROOT, "assets", manifest.icon);
  if (!fs.existsSync(iconSrc)) fatal("身份图标缺失：assets/" + manifest.icon);
  fs.mkdirSync(path.dirname(path.join(DIST, manifest.icon)), { recursive: true });
  fs.copyFileSync(iconSrc, path.join(DIST, manifest.icon));

  // 4) 断言：构建产物在位
  for (const name of BUILT_FILES) {
    if (!fs.existsSync(path.join(DIST, name))) fatal("缺 dist/" + name + "（构建脚本未产出）");
  }

  // 5) 断言：manifest 声明的入口必须在交付树里真实存在。
  //    缺了就是「装上也起不来」的静默缺口，不该等到用户机器上才暴露。
  if (typeof manifest.entry !== "string" || !fs.existsSync(path.join(DIST, manifest.entry))) {
    fatal("manifest.entry 指向的文件不在交付树里：" + String(manifest.entry));
  }

  // 6) 断言：交付树里绝不能出现源码与开发件。
  //    这是白名单的最后一道保险——拷贝逻辑改了、或将来有人加了目录，这里会当场拦住。
  const FORBIDDEN = [
    "src", // 源码（已 bundle）
    "scripts", // 构建脚本
    "node_modules", // 构建期依赖
    "package.json", // .mjs 自带 ESM 语义，不需要它跟包
    "pnpm-lock.yaml",
    "assets", // 图标已按 manifest.icon 落位，不整树随包
    "dist-extensions",
    "releases",
    ".git",
    ".tmp",
  ];
  const leaked = FORBIDDEN.filter((p) => fs.existsSync(path.join(DIST, p)));
  if (leaked.length) fatal("交付树里出现了不该有的路径：" + leaked.join("、"));

  const files = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else files.push(rel(p));
    }
  };
  walk(DIST);
  log("完成：" + rel(DIST) + " 共 " + files.length + " 个文件（白名单交付面）");
  for (const f of files) {
    const size = fs.statSync(path.join(ROOT, f)).size;
    log("  " + f + "  " + (size / 1024).toFixed(1) + " KB");
  }
}

main();
