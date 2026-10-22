// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * packages/app/src/app.mjs — hana-run-code App v2 主体（导出 apply(ctx)）。
 *
 * 形态：宿主在隔离 App 进程里加载本文件、调用 apply(ctx)，注册完成后立即返回。
 *
 * ## 为什么入口不 import 任何 SDK
 *
 * 宿主把 ctx 直接交给 apply，工具注册用的就是 ctx.tools.register 这个对象本身。
 * 不 import @hana/app-sdk 意味着：这个 App 的**运行期**与 SDK 版本完全解耦——宿主升级
 * App SDK 不会让这个包失效，也不存在「随包的 SDK 副本过期」这件事。仓库里因此没有
 * vendor 快照，也没有 sync 脚本要维护。
 *
 * 代价说清楚：没有 SDK 就等于没有类型、没有 createAppSdk 那层包装（它做的只是把
 * 域方法 Promise 化并给出 AppRegistration 回执，本文件用不到第二项）。一个只有单工具、
 * 无设置页、无卡片的 App 不需要那一层。
 *
 * ## 权限与执行边界
 *
 * manifest 只声明两项能力：
 *   · app/tools.expose-to-model —— 工具进模型可调用面（用户须在设置里批准）
 *   · app/process.spawn        —— 允许裸 child_process（run_code 靠它起 node）
 *
 * App 进程本身受 Node Permission Model 约束（fs 只能读安装目录与 dataDir）。程序正文
 * 经 stdin 交给 spawn 出去的 node，不经过 App 进程的 fs。子进程的授权集由
 * lib/run.mjs 重新声明（工作区 + 临时目录），与 App 进程那套无关。
 */
import * as runCodeTool from "./tool.mjs";

/**
 * @param {object} ctx 宿主提供的 App 上下文
 * @returns {Function|undefined} disposer（宿主卸载/重载时调用）
 */
export function apply(ctx) {
  const log = makeLogger(ctx);
  const dataDir = ctx && typeof ctx.dataDir === "string" && ctx.dataDir ? ctx.dataDir : null;
  if (!dataDir) {
    throw new Error("hana-run-code apply: ctx.dataDir 缺失（宿主未提供数据目录）");
  }

  // 工具执行期的日志出口：宿主 logger 优先，缺失或抛错回落 stderr（宁可吵，不静默丢日志）。
  const toolLog = {
    debug: (...a) => log("debug", ...a),
    info: (...a) => log("info", ...a),
    warn: (...a) => log("warn", ...a),
    error: (...a) => log("error", ...a),
  };

  const deps = { dataDir, log: toolLog };

  const unregister = ctx.tools.register({
    name: runCodeTool.name,
    description: runCodeTool.description,
    parameters: runCodeTool.parameters,
    // 单参数调用：宿主传 { ...args, context }。第二个形参只为兼容旧口径，不依赖。
    execute: (input) => runCodeTool.execute(input, deps),
    // 该工具会跑任意程序，不属于只读类，按审查口径处理。
    sessionPermission: { readOnly: false },
  });

  log("info", "hana_run_code 已注册（subprocess 执行，输出截断 256KB/通道）");

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    try {
      if (typeof unregister === "function") unregister();
    } catch { /* 忽略 */ }
    log("info", "hana-run-code disposer：工具已注销");
  };
}

/** ctx.logger 优先；缺失或抛错回落 stderr。 */
function makeLogger(ctx) {
  const logger = ctx && ctx.logger;
  return (level, ...args) => {
    if (logger && typeof logger[level] === "function") {
      try {
        logger[level](...args);
        return;
      } catch { /* 回落 stderr */ }
    }
    try {
      console.error("[hana-run-code] [" + level + "]", ...args);
    } catch { /* 忽略 */ }
  };
}

export default { apply };
