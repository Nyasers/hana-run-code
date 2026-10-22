// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * packages/tools/src/hana-run-code.mjs — run_code 工具的定义与执行。
 *
 * ## 这个工具是什么，不是什么
 *
 * 它是「跑一段临时 Node 程序」。**它不在代码里代理宿主的工具**——调用方写的程序里
 * 没有 `tools.xxx()`，只有 Node 本身（fs / child_process / 任意 npm 内置模块）。
 * 所以它是 run_code，不是 PTC：PTC 要的是「代码里调用工具」，那半边得靠宿主侧的
 * codemode 来做编排。
 *
 * 边界写在参数上，不写在文档里：code（程序正文）、description（做什么）、
 * cwd（工作目录）、timeoutMs（时间上限）。没有 allowedTools，因为这个工具没有工具可放行。
 *
 * ## 输出契约
 *
 * 两个出口，都是一个方向：
 * - `return x`：包装层把程序体包进 async 函数，返回值自动打印（字符串原样，其余 JSON）。
 * - `console.log`：进 stdout；`console.error` 进 stderr。
 *
 * 两者各自截断到 256 KB。没有第三个出口（不读 stdin、不看进程退出时的内存状态）。
 */
import {
  runNodeProgram,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  DEFAULT_SANDBOX,
  SANDBOX_MODES,
} from "./lib/run.mjs";

export const name = "hana_run_code";

export const description = [
  "跑一段临时 Node / TypeScript 程序并只回传它的 stdout / stderr。",
  "凡是能用 Node 表达而不用改仓库文件的一次性计算，优先用它而不是 shell 命令：算 hash、列目录并过滤、比对两个文件、批量改名前的预演、读多个文档只取结论、JSON/YAML 处理、统计与聚合、起子进程跑一条命令。",
  "比起 shell（pwsh/bash）的优势：程序正文直接交给 node，中间不过引号与变量展开，不会有转义咬人；结构化数据可以直接 return，不会被表格格式化截断；一段逻辑可以用临时变量拆开，而不是拼成一条管道。",
  "程序里没有宿主工具（不能调 read/grep/web_search）——它的能力来自 Node 本身。",
  "程序在独立 node 子进程里跑，顶层 await 与 return 都可用；return 的值会自动打印（字符串原样，其余 JSON）。",
  "可以用 TypeScript，但只支持 erasable 语法（类型注解、interface、type、泛型、as）：类型会被擦除，不做转译，所以 enum / namespace 这类需要生成代码的写法会报错。",
  "沙箱：默认 workspace（可读写 cwd 与系统临时目录），readonly 能读不能写，inherit 沿用宿主授权。",
  "输出各自截断到 256KB。",
].join("\n");

export const parameters = {
  type: "object",
  properties: {
    code: {
      type: "string",
      description:
        "程序正文（ES module，可用 TypeScript 的 erasable 语法）。可 import node:fs 等内置模块，可用顶层 await。用 return 交结果（会自动打印），或 console.log。",
    },
    description: {
      type: "string",
      description: "一句话说明这段程序做什么。不参与执行，用于阅读记录。",
    },
    cwd: {
      type: "string",
      description:
        "工作目录（绝对路径），同时是沙箱的授权根。相对路径按它解析；缺省为 App 数据目录。要操作的目录不在其中时，把它设成目标目录。",
    },
    sandbox: {
      type: "string",
      enum: SANDBOX_MODES,
      description:
        "沙箱档位，默认 " + DEFAULT_SANDBOX + "。workspace=能读写 cwd 目录树；readonly=能读 cwd 不能写；inherit=沿用宿主给 App 的授权（安装目录 + 数据目录）。",
    },
    sandboxTemp: {
      type: "boolean",
      description:
        "是否授权系统临时目录（os.tmpdir()，Windows 一般是 %TEMP%，POSIX 一般是 /tmp），可读可写。默认 true：很多库会往那里落缓存。",
    },
    timeoutMs: {
      type: "integer",
      description:
        "超时毫秒数，默认 " + DEFAULT_TIMEOUT_MS + "，最大 " + MAX_TIMEOUT_MS + "。超时后连同子进程树一起终止。",
      minimum: 1000,
      maximum: MAX_TIMEOUT_MS,
    },
  },
  required: ["code", "description"],
  additionalProperties: false,
};

/**
 * 工具执行入口。
 *
 * @param {object} input  宿主的单参数调用：{ ...args, context }
 * @param {object} deps   { dataDir, log }
 */
export async function execute(input, deps) {
  const args = input || {};
  const context = args.context || {};
  const code = args.code;
  const dataDir = deps && deps.dataDir;
  // deps.log 是 { debug, info, warn, error } 四个方法，不是单个函数。
  const logger = (deps && deps.log) || null;
  const log = (level, ...rest) => {
    if (logger && typeof logger[level] === "function") {
      try { logger[level](...rest); } catch { /* 日志失败不影响执行 */ }
    }
  };

  if (typeof code !== "string" || !code.trim()) {
    return fail("code 不能为空：请传入要执行的程序正文。");
  }
  if (!dataDir) {
    return fail("App 数据目录不可用：宿主未提供 ctx.dataDir，无法落临时脚本。");
  }

  log("info", "run_code 开始：" + (args.description || "(无描述)") + "，cwd=" + (args.cwd || "(dataDir)"));

  const result = await runNodeProgram({
    code,
    dataDir,
    cwd: args.cwd,
    sandbox: args.sandbox,
    sandboxTemp: args.sandboxTemp,
    timeoutMs: args.timeoutMs,
  });

  log(
    "info",
    "run_code 结束：ok=" + result.ok + " exit=" + result.exitCode + " 耗时=" + result.durationMs + "ms",
  );

  const head = [
    "exitCode: " + (result.exitCode === null ? "(spawn 失败)" : result.exitCode),
    "durationMs: " + result.durationMs,
    "sandbox: " + (SANDBOX_MODES.includes(args.sandbox) ? args.sandbox : DEFAULT_SANDBOX),
    args.sandboxTemp !== false ? "temp: on" : "temp: off",
    result.timedOut ? "timedOut: true" : null,
    result.outputTruncated ? "output: 已截断到 " + Math.round(MAX_OUTPUT_BYTES / 1024) + "KB" : null,
  ]
    .filter(Boolean)
    .join("  ");

  const parts = [head];
  if (result.message) parts.push("message: " + result.message);
  if (result.stdout) parts.push("--- stdout ---\n" + result.stdout);
  if (result.stderr) parts.push("--- stderr ---\n" + result.stderr);
  if (!result.stdout && !result.stderr) parts.push("--- 程序没有产生输出 ---");

  const text = parts.join("\n\n");
  return result.ok
    ? { content: [{ type: "text", text }] }
    : { content: [{ type: "text", text }], isError: true };
}

function fail(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}
