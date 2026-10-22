// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * packages/tools/src/lib/run.mjs — 跑一段临时 Node 程序并回收它的输出。
 *
 * ## 权限模型：子进程真的会继承
 *
 * 宿主把 App 跑在 `--permission` 下，并通过环境变量 `NODE_OPTIONS` 传递该设置。
 * spawn 时**向 `env` 写入 `NODE_OPTIONS: ""` 拦不住它**：实测子进程的
 * `process.env.NODE_OPTIONS` 仍是宿主那一串完整权限，它只看到
 * `--allow-fs-read=<安装目录> --allow-fs-read=<dataDir> --allow-child-process`。
 * 所以本 App 的代码默认**读不了 dataDir 以外的任何路径**（`ERR_ACCESS_DENIED`）。
 *
 * 但 `--allow-child-process` 本身是开口子：子进程可以再 spawn 一个孙进程，并在命令行上
 * 追加 `--allow-fs-read=*`，实测可读到全盘。权限模型在“已允许起子进程”之后就不再构成
 * 边界，这是 Node 26 的固有性质，不是本 App 可修的问题。
 *
 * 实际含义：本工具的硬边界是 dataDir；越过它的能力靠 `--allow-child-process` 这个
 * 授权本身，而不是靠本工具的实现。要读工作区就把 `cwd` 指向那里——宿主运行时会在
 * 子进程环境里保留自己的授权集，本工具不伪造也不放大它。
 *
 * ## 为什么还要 spawn
 *
 * 即使被关在笼子里，「一段临时程序」仍然比让模型逐文件调工具短得多：程序内部可以遍历、
 * 聚合、算完只吐结论。此外子进程跑完即死，不留状态；而 App 进程里的 eval 会把任何
 * 全局污染、内存泄漏带到下一次调用。
 *
 * ## 为什么不落盘
 *
 * 程序正文直接写进子进程的 stdin（`--input-type=module-typescript`），磁盘上不产生
 * 任何临时文件。除了“没有残留要清”之外，这还避开了两个权限模型的实际障碍：
 * 把一个文件路径写进 `--allow-fs-read` 会让整串授权失效；而授脚本所在目录又会和
 * 临时目录这类父目录条目打起来。
 *
 * 代价是错误栈里看到的是 `[eval]` 而不是文件名。行号仍指向程序本身（只多出包装头
 * 那几行），比“授权表无端失效”好定位得多。
 */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

/** 单次执行的时间上限（毫秒）。超时后杀进程树。 */
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 300_000;
/** stdout / stderr 各自保留的上限（字节）。超出即截断并标记。 */
export const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * 沙箱档位。
 *
 * - `workspace`（默认）：只能读写 cwd 指向的那个目录树。
 * - `readonly`：能读 cwd，不能写。纯分析、统计、只读汇报用这个。
 * - `inherit`：不重写权限参数，沿用宿主给 App 的那一套（安装目录 + dataDir）。
 *   只有需要读 App 自己的数据目录才用。
 */
export const SANDBOX_MODES = ["workspace", "readonly", "inherit"];
export const DEFAULT_SANDBOX = "workspace";

/**
 * 路径归一：一律用正斜杠进 NODE_OPTIONS。
 *
 * 实测（Node 26 / Windows）：`NODE_OPTIONS` 是空白分隔的字符串而不是 argv 数组，
 * 混用反斜杠与正斜杠会出现“写得到、读不到”这类怪现象。统一斜杠后不再出现。
 */
const slash = (p) => String(p).replace(/\\/g, "/");

/**
 * 去掉被其他授权路径覆盖的条目。
 *
 * 子目录原本就会继承父目录的授权（实测：授 `E:/W` 读写后，
 * `E:/W/.tmp/inh/sub/deep` 照样 W_OK），所以单独列子目录没有收益。反过来有害：
 * 实测（Node 26 / Windows）授权表里同时出现父目录与子目录时，父目录那条会失效——
 *
 *   read=T read=T/sub   -> 只读得到 T/sub，T 本身 DENY
 *   read=T              -> T 与 T/sub 都能读
 *
 * 保留最小集合就不会踩到。
 */
function pruneCovered(paths) {
  const once = [...new Set(paths.map(slash))];
  return once.filter((p) => {
    const own = p.replace(/\/+$/, "");
    return !once.some((other) => {
      const o = other.replace(/\/+$/, "");
      if (o === own) return false;
      return own.toLowerCase().startsWith(o.toLowerCase() + "/");
    });
  });
}

/**
 * 按照沙箱档位拼出子进程的 NODE_OPTIONS。
 *
 * ## 为什么这是「替换」而不是「追加」
 *
 * 实测：子进程启动时 Node 用这里给的值整套覆盖父进程的权限参数。给
 * `--allow-fs-read=<ws>` 之后，连宿主本来授权的 dataDir 与安装目录都变成了
 * `ERR_ACCESS_DENIED`。所以这不是“在已有权限上加一条”，而是“重新规定边界”——
 * 正好是 workspace-write 需要的语义。
 *
 * ## 程序不落盘
 *
 * 程序正文走子进程的 stdin（`--input-type=module-typescript`），因此授权表里不需要任何脚本
 * 路径，只剩「哪里可读写」。这一条同时避开了两个坑：把文件路径写进
 * `--allow-fs-read` 会让整串授权失效；把脚本目录也列进来又会和 tmp 这类父目录条目
 * 打起来（见 pruneCovered）。
 *
 * ## 写权限给两处
 *
 * 工作区（`cwd`）与系统临时目录。实测 `os.tmpdir()` 不会被自动授权，而很多程序与
 * 库默认往那里落缓存，少了它只能报 `ERR_ACCESS_DENIED`。tmp 是系统级丢弃区，
 * 放进来不削弱工作区边界。`sandboxTemp: false` 可关掉。
 *
 * `tmpRoot` 可以让调用方指定另一个临时目录（比如指向一块更快的盘）。给什么路径都行，
 * 只要它已存在——能不能建目录是 App 进程的事，与这里无关。
 *
 * ## `--allow-child-process` 保留
 *
 * 程序里可能需要起外部命令（git、构建）。保留它意味着本层沙箱对「程序主动放宽
 * 自己的权限」是开放的（孙进程可再加 `--allow-fs-read=*`）。这是刻意的：这个工具
 * 服务的是本机可信调用方，边界防误伤，不防故意越狱。
 *
 * @param {string} mode       SANDBOX_MODES 之一
 * @param {string} root       工作区根（绝对路径）
 * @param {boolean} [withTemp] 是否附加系统临时目录（可读可写）
 * @returns {string} 传给子进程的 NODE_OPTIONS
 */
export function buildSandboxOptions(mode, root, withTemp) {
  if (mode === "inherit") return process.env.NODE_OPTIONS || "";

  const reads = [root];
  const writes = [root];
  if (withTemp) {
    reads.push(os.tmpdir());
    writes.push(os.tmpdir());
  }

  const parts = ["--permission"];
  for (const p of pruneCovered(reads)) parts.push("--allow-fs-read=" + p);
  parts.push("--allow-child-process");
  if (mode !== "readonly") {
    for (const p of pruneCovered(writes)) parts.push("--allow-fs-write=" + p);
  }
  return parts.join(" ");
}

const CRLF = /\r\n?/g;
const normalizeNewlines = (s) => String(s ?? "").replace(CRLF, "\n");

/**
 * 杀掉一个子进程**及其子孙**。
 *
 * Windows 上 `child.kill()` 只 TerminateProcess 那一个进程：程序若 fork 出孙进程
 * （或起了一条外部命令），它们继承着 stdout 管道，主进程死了管道仍在，`close` 事件
 * 永远不来——调用方就永远等在那。所以 Windows 走 taskkill /T。
 */
function terminateTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).on("error", () => {
        try { child.kill(); } catch { /* 已退出 */ }
      });
      return;
    } catch { /* 落到下面的单进程 kill */ }
  }
  try { child.kill(); } catch { /* 已退出 */ }
}

/** 输出累积器：超限只保留前 MAX_OUTPUT_BYTES，并记住曾经超出。 */
function makeSink() {
  const chunks = [];
  let size = 0;
  let truncated = false;
  return {
    push(buf) {
      if (size >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const room = MAX_OUTPUT_BYTES - size;
      if (buf.length > room) {
        chunks.push(buf.subarray(0, room));
        size = MAX_OUTPUT_BYTES;
        truncated = true;
        return;
      }
      chunks.push(buf);
      size += buf.length;
    },
    read() {
      return normalizeNewlines(Buffer.concat(chunks).toString("utf8"));
    },
    get truncated() {
      return truncated;
    },
  };
}

/**
 * 按当前平台判断绝对路径。
 *
 * 不能直接用 `path.isAbsolute`：它在 Windows 上把 `/tmp` 也算绝对（归一成 `\tmp`），
 * 而那是个没有盘符的路径，指到哪里看进程当前盘，不适合当工作区根用。
 */
function isAbsoluteOnPlatform(p) {
  if (process.platform === "win32") return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
  return p.startsWith("/");
}

/** 超时归一：非法或缺失回落默认值，夹在 [1s, MAX_TIMEOUT_MS]。 */
export function normalizeTimeoutMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(n), 1000), MAX_TIMEOUT_MS);
}

/**
 * 把用户程序重新组装成「import 在顶层 + 代码体在 async 函数里」的模块。
 *
 * ## 为什么要包装
 *
 * ES module 的顶层不允许 `return`，而「算出个东西交回去」是最自然的写法。包装一屡就
 * 让 `return` 合法，并且最后一行的值会被自动打印——`return {a:1}` 比
 * `console.log(JSON.stringify({a:1}))` 短，也不容易漏括号。
 *
 * ## 为什么要把 import 抽出来
 *
 * `import` 静态声明只能出现在模块顶层，放进 async 函数里是语法错误。所以先按行扫描
 * 把顶层的 import 语句（含跨行与副作用 import）提到包装体外，其余送进函数体。
 *
 * 副作用：报错行号不再是用户看到的那个数字（前面多了包装头与上移的 import）。宁肯
 * 这样也不去伪造行号映射，因为伪造错了比偏移更难查。
 *
 * @param {string} source 用户写的程序正文
 * @returns {string} 可直接执行的模块源码
 */
function wrapProgram(source) {
  const lines = normalizeNewlines(source).split("\n");
  const imports = [];
  const body = [];

  // 模块说明符已闭合 => 这条 import 结束。跨行 import 靠它继续累积。
  const isComplete = (s) => {
    const hasSpecifier = /from\s*['"][^'"]*['"]|^\s*import\s*['"][^'"]*['"]/.test(s);
    return hasSpecifier && /['"]\s*;?\s*(\/\/.*)?$/.test(s.trim());
  };

  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import[\s{*'"]/.test(lines[i])) {
      let buf = lines[i];
      while (!isComplete(buf) && i + 1 < lines.length) {
        i++;
        buf += "\n" + lines[i];
      }
      imports.push(buf);
      continue;
    }
    body.push(lines[i]);
  }

  const head = imports.length ? imports.join("\n") + "\n" : "";
  return (
    head +
    "const __hana_run = async () => {\n" +
    body.join("\n") +
    "\n};\n" +
    "const __hana_value = await __hana_run();\n" +
    "if (__hana_value !== undefined) {\n" +
    "  console.log(typeof __hana_value === 'string' ? __hana_value : JSON.stringify(__hana_value, null, 2));\n" +
    "}\n"
  );
}

/**
 * 执行一段 ES 模块源码。
 *
 * @param {object} input
 * @param {string} input.code    程序正文（ES module；顶层 await 与 return 可用）
 * @param {string} input.dataDir App 自有可写目录，临时脚本落在这里
 * @param {string} [input.cwd]   子进程工作目录；缺省用 dataDir
 * @param {string} [input.sandbox] 沙箱档位，默认 workspace
 * @param {boolean} [input.sandboxTemp] 是否放行系统临时目录
 * @param {number} [input.timeoutMs]
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, exitCode:number|null,
 *   signal:string|null, durationMs:number, timedOut:boolean,
 *   outputTruncated:boolean, truncated:boolean, message?:string}>}
 */
export function runNodeProgram(input) {
  const { code, dataDir, cwd, timeoutMs } = input;
  const sandbox = SANDBOX_MODES.includes(input.sandbox) ? input.sandbox : DEFAULT_SANDBOX;
  const budget = normalizeTimeoutMs(timeoutMs);
  const startedAt = Date.now();

  // 授权根：给了 cwd 就用它，给不了才回退 dataDir。
  //
  // 不能在这里用 `fs.existsSync(cwd)` 判断：App 进程只被授权了安装目录与 dataDir，
  // 呼一声 existsSync 到工作区就直接抛 ERR_ACCESS_DENIED，整个调用当场挂掉。
  // 路径存不存在交给子进程去撞（推不动就直接报错，比默默回退到 dataDir 更好定位）。
  const workRoot = cwd && isAbsoluteOnPlatform(cwd) ? cwd : dataDir;
  const withTemp = input.sandboxTemp !== false;

  // 程序从 stdin 交给 node，不落盘：
  // - 不需要额外授权一个脚本路径；把文件路径写进 `--allow-fs-read` 会让整串授权失效；
  // - 不留任何临时脚本，也就不存在残留与并发互相看见的问题。
  //
  // TS 走 `module-typescript`：Node 只擦除类型注解，不做语法转译，所以 enum、
  // namespace 这类需要生成代码的 TS 特性会直接报错（erasable-only）。
  //
  // 可执行文件就用 `process.execPath`：宿主本身是纯 Node 运行时（实测 v26.8.1，
  // 无 Electron），所以无需用户另装 node，也不必回落到别的 runtime——
  // 宿主只会往前走，它带的 node 只会更新。这样本工具看到的版本与宿主执行代码时
  // 看到的是同一个，不会出现“宿主里行、这里不行”的错位。
  const program = wrapProgram(code);

  const out = makeSink();
  const err = makeSink();

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // 收尾：stdout/stderr 已读尽，没有临时文件要清（程序从 stdin 来，不落盘）。
      resolve({
        ...result,
        stdout: out.read(),
        stderr: err.read(),
        durationMs: Date.now() - startedAt,
        timedOut,
        outputTruncated: out.truncated || err.truncated,
        truncated: out.truncated || err.truncated,
      });
    };

    let child;
    try {
      child = spawn(process.execPath, ["--input-type=module-typescript"], {
        cwd: workRoot,
        // 不传 shell：参数是数组，Windows 与 POSIX 一致，免转义。
        shell: false,
        windowsHide: true,
        // stdin 送程序正文，不落盘；stdout/stderr 收结果。
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          // 整套覆盖宿主的权限参数：工作区、临时目录，以及起子进程的许可。
          // 清空它无效（实测会被父进程恢复），只能重新声明。
          NODE_OPTIONS: buildSandboxOptions(sandbox, workRoot, withTemp),
          // 明确这是临时执行环境（程序里可用它判断）。
          HANA_RUN_CODE: "1",
        },
      });
    } catch (e) {
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        message: "无法启动 node 子进程：" + ((e && e.message) || e),
      });
      return;
    }

    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));

    // 程序正文走 stdin，写完立即关闭让它开跑（不关就永远等输入）。
    child.stdin.on("error", () => { /* 子进程可能先退出，忽略 EPIPE */ });
    child.stdin.end(program);

    timer = setTimeout(() => {
      timedOut = true;
      terminateTree(child);
    }, budget);
    if (timer.unref) timer.unref();

    child.on("error", (e) => {
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        message: "node 子进程启动失败：" + ((e && e.message) || e),
      });
    });

    child.on("close", (code, signal) => {
      const ok = !timedOut && code === 0 && !signal;
      finish({
        ok,
        exitCode: code,
        signal: signal ?? null,
        message: timedOut
          ? "程序超过 " + Math.round(budget / 1000) + " 秒未结束，已终止"
          : ok
            ? undefined
            : "程序以退出码 " + code + (signal ? "（signal " + signal + "）" : "") + " 结束",
      });
    });
  });
}
