// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/dev/try-tool.mjs — 不经宿主，直接调 bundle 里的工具跑一遍。
 *
 * ## 为什么需要它
 *
 * 宿主的冒烟测试只能证明「App 能加载、工具能注册」；工具**执行**才是这个 App 的全部
 * 内容，而它依赖的东西（子进程、dataDir、输出截断、超时）宿主冒烟都不碰。
 *
 * 这里直接 import 产物里的 bin/app.mjs，用一个假的 ctx 调 apply()，再把工具 shim 出来
 * 执行。它不证明宿主侧的契约（那由 validate_app --smoke 证明），只证明「跑代码这件事
 * 真的跑得起来」。两者互补，谁也不能替代谁。
 *
 * 用法：node scripts/dev/try-tool.mjs [用例名]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLE = path.join(ROOT, "dist", "bin", "app.mjs");

if (!fs.existsSync(BUNDLE)) {
  console.error("[try-tool] 缺 dist/bin/app.mjs：先跑 node scripts/build-app.mjs");
  process.exit(1);
}

/** 最小可用的假 ctx：只提供 apply 真正读到的字段。 */
function makeCtx(dataDir) {
  const logs = [];
  const registered = [];
  return {
    dataDir,
    logs,
    registered,
    logger: {
      debug: (...a) => logs.push(["debug", ...a]),
      info: (...a) => logs.push(["info", ...a]),
      warn: (...a) => logs.push(["warn", ...a]),
      error: (...a) => logs.push(["error", ...a]),
    },
    tools: {
      register: (tool) => {
        registered.push(tool);
        return () => {
          const i = registered.indexOf(tool);
          if (i >= 0) registered.splice(i, 1);
        };
      },
    },
  };
}

const CASES = {
  /** 基本：console.log 有输出，退出码 0 */
  basic: {
    args: {
      code: 'console.log("hello from run_code");',
      description: "打印一行",
    },
    check: (r) => /hello from run_code/.test(text(r)) && !r.isError,
  },

  /** workspace 档：能读写 cwd，但读不到工作区其他部分 */
  sandboxWorkspace: {
    args: {
      cwd: "@WS@",
      sandbox: "workspace",
      code: [
        'import { readdirSync, writeFileSync, unlinkSync } from "node:fs";',
        'const R = (p) => { try { readdirSync(p); return "OK"; } catch (e) { return "DENY"; } };',
        'const r = R("@WS@");',
        'let w; try { writeFileSync("@WS@/t.txt", "x"); w = "OK"; unlinkSync("@WS@/t.txt"); } catch (e) { w = "DENY"; }',
        'return { wsRead: r, wsWrite: w, outside: R("C:/") };',
      ].join("\n"),
      description: "workspace 沙箱：读写 cwd、隔绝外部",
    },
    check: (r) => /"wsRead": "OK"/.test(text(r)) && /"wsWrite": "OK"/.test(text(r)) && /"outside": "DENY"/.test(text(r)),
  },

  /** readonly 档：能读不能写 */
  sandboxReadonly: {
    args: {
      cwd: "@WS@",
      sandbox: "readonly",
      code: [
        'import { readdirSync, writeFileSync } from "node:fs";',
        'let w; try { writeFileSync("@WS@/t.txt", "x"); w = "OK"; } catch (e) { w = "DENY"; }',
        'return { read: readdirSync("@WS@").length >= 0 ? "OK" : "?", write: w };',
      ].join("\n"),
      description: "readonly 沙箱：能读不能写",
    },
    check: (r) => /"read": "OK"/.test(text(r)) && /"write": "DENY"/.test(text(r)),
  },

  /** tmp 默认可读写（许多库会往 tmp 落缓存） */
  tempOnByDefault: {
    args: {
      cwd: "@WS@",
      sandbox: "workspace",
      code: [
        'import { writeFileSync, unlinkSync, readdirSync } from "node:fs";',
        'import os from "node:os";',
        'import path from "node:path";',
        'const tmp = os.tmpdir();',
        'let w; try { const f = path.join(tmp, "__hc_probe.txt"); writeFileSync(f, "x"); unlinkSync(f); w = "OK"; } catch (e) { w = "DENY"; }',
        'let r; try { readdirSync(tmp); r = "OK"; } catch (e) { r = "DENY"; }',
        'return { tmpRead: r, tmpWrite: w };',
      ].join("\n"),
      description: "tmp 默认可读写",
    },
    check: (r) => /"tmpRead": "OK"/.test(text(r)) && /"tmpWrite": "OK"/.test(text(r)),
  },

  /** sandboxTemp=false：tmp 被关掉，工作区仍可写 */
  tempOffExplicitly: {
    args: {
      cwd: "@WS@",
      sandbox: "workspace",
      sandboxTemp: false,
      code: [
        'import { writeFileSync, readdirSync } from "node:fs";',
        'import os from "node:os";',
        'let t; try { readdirSync(os.tmpdir()); t = "OK"; } catch (e) { t = "DENY"; }',
        'let w; try { writeFileSync("@WS@/z.txt", "x"); w = "OK"; } catch (e) { w = "DENY"; }',
        'return { tmp: t, workspace: w };',
      ].join("\n"),
      description: "sandboxTemp=false 关闭系统 tmp",
    },
    check: (r) => /"tmp": "DENY"/.test(text(r)) && /"workspace": "OK"/.test(text(r)),
  },

  /** TypeScript：erasable 语法的类型注解能用 */
  tsTypes: {
    args: {
      cwd: "@WS@",
      code: [
        'interface Row { name: string; n: number }',
        'const rows: Row[] = [{ name: "a", n: 1 }, { name: "b", n: 2 }];',
        'const total: number = rows.reduce((s: number, r: Row) => s + r.n, 0);',
        'return { total, first: rows[0]!.name };',
      ].join("\n"),
      description: "TS 类型注解",
    },
    check: (r) => /"total": 3/.test(text(r)) && /"first": "a"/.test(text(r)),
  },

  /** TypeScript：import type 能被擦除 */
  tsImportType: {
    args: {
      cwd: "@WS@",
      code: [
        'import type { Stats } from "node:fs";',
        'import fs from "node:fs";',
        'const s: Stats = fs.statSync("@WS@");',
        'return { isDir: s.isDirectory() };',
      ].join("\n"),
      description: "TS import type",
    },
    check: (r) => /"isDir": true/.test(text(r)),
  },

  /** TypeScript：纯 JS 照样能跑（向后兼容） */
  tsPlainJsStillWorks: {
    args: {
      cwd: "@WS@",
      code: 'const a = 1;\nreturn { a, doubled: a * 2 };',
      description: "纯 JS 向后兼容",
    },
    check: (r) => /"doubled": 2/.test(text(r)),
  },

  /** TypeScript：enum 需要代码生成，必须报错（erasable-only 的边界） */
  tsNonErasableRejected: {
    args: {
      cwd: "@WS@",
      code: 'enum E { A }\nreturn { v: E.A };',
      description: "enum 应被拒",
    },
    check: (r) =>
      r.isError === true ||
      /ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|not supported in strip-only/.test(text(r)),
  },

  /** inherit 档：回到宿主那一套授权（能读 App 数据目录） */
  sandboxInherit: {
    args: {
      sandbox: "inherit",
      // @DATA@ 由主程序换成本次的临时 dataDir：inherit 档的授权来自 App 进程自己
      // 那串 NODE_OPTIONS，而那串里写的是真实 dataDir。写死本机路径在别处一定读不到。
      code: [
        'import { readdirSync } from "node:fs";',
        'return { dataDir: readdirSync("@DATA@").length >= 0 ? "OK" : "?" };',
      ].join("\n"),
      description: "inherit 沙箱：沿用宿主授权",
    },
    check: (r) => /"dataDir": "OK"/.test(text(r)),
  },

  /** 顶层 await */
  topLevelAwait: {
    args: {
      code: [
        'const v = await Promise.resolve(42);',
        'console.log("value:", v);',
      ].join("\n"),
      description: "顶层 await",
    },
    check: (r) => /value: 42/.test(text(r)),
  },

  /** 非零退出：应标记为错误并保留 stderr */
  throws: {
    args: {
      code: 'console.error("boom"); process.exit(3);',
      description: "非零退出",
    },
    check: (r) => r.isError === true && /boom/.test(text(r)) && /exitCode: 3/.test(text(r)),
  },

  /** 超时：无限循环应被终止，且不能挂死 */
  timeout: {
    args: {
      code: 'console.log("start"); while (true) {}',
      description: "超时终止",
      timeoutMs: 1500,
    },
    check: (r) => /timedOut: true/.test(text(r)) && /start/.test(text(r)),
  },

  /** 返回出口：return 的值应自动打印出来（value 与 string 两种形态） */
  returnValue: {
    args: {
      code: 'const n = 6 * 7;\nreturn { answer: n, tag: "ok" };',
      description: "return 对象",
    },
    check: (r) => /"answer": 42/.test(text(r)) && /"tag": "ok"/.test(text(r)) && !r.isError,
  },

  /** return 字符串与 import 共存 */
  returnEdges: {
    args: {
      cwd: "@WS@",
      sandbox: "workspace",
      code: [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync("@WS@/host.txt", "ok");',
        'return "wrote under workspace";',
      ].join("\n"),
      description: "return 字符串 + import 共存",
    },
    check: (r) => /wrote under workspace/.test(text(r)) && !/__hana/.test(text(r)),
  },

  /** 空 code：应在进入子进程前就被拒 */
  emptyCode: {
    args: { code: "   ", description: "空代码" },
    check: (r) => r.isError === true && /code 不能为空/.test(text(r)),
  },

  /** 输出截断：大量输出只保留前 256KB */
  truncation: {
    args: {
      // 真输出 1MB：超过 MAX_OUTPUT_BYTES 才会触发截断标记。
      code: 'process.stdout.write("x".repeat(1024 * 1024));',
      description: "输出截断",
    },
    check: (r) => /output: 已截断/.test(text(r)),
  },
};

const text = (r) => (r.content || []).map((c) => c.text || "").join("\n");

/**
 * 用例里引用的工作区路径写成占位符，跑之前换成实际目录。
 *
 * 不直接把本机绝对路径写进用例：换一台机器（或 CI）那段路径不存在，沙箱用例会
 * 全部报错，看起来像沙箱坏了。占位符让用例自带一个自己的临时目录。
 */
const WS_PLACEHOLDER = "@WS@";
const DATA_PLACEHOLDER = "@DATA@";

// 用例用的工作区：建在 os.tmpdir() 下，模块加载时就有，供 withWorkspace 引用。
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "hrc-ws-")).replace(/\\/g, "/");
// 本次的 dataDir：apply 与 inherit 用例共用同一个。
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hrc-try-")).replace(/\\/g, "/");

const withWorkspace = (value) =>
  typeof value === "string"
    ? value.split(WS_PLACEHOLDER).join(WS).split(DATA_PLACEHOLDER).join(DATA_DIR)
    : Array.isArray(value)
      ? value.map(withWorkspace)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withWorkspace(v)]))
        : value;


async function main() {
  const only = process.argv[2];
  const dataDir = DATA_DIR;

  const mod = await import(pathToFileURL(BUNDLE).href);
  const dispose = mod.apply(makeCtx(dataDir));
  const ctx = { registered: [] };

  // apply 已经跑过，工具在假 ctx 里；重新建一个拿到注册表。
  const fake = makeCtx(dataDir);
  mod.apply(fake);
  const tool = fake.registered[0];
  if (!tool) {
    console.error("[try-tool] apply 之后没有任何工具注册");
    process.exit(1);
  }
  console.log("[try-tool] 工具已注册：" + tool.name);
  console.log("[try-tool] 参数键：" + Object.keys(tool.parameters.properties).join(", "));
  console.log("");

  const names = only ? [only] : Object.keys(CASES);
  let pass = 0;
  let fail = 0;

  for (const name of names) {
    const c = CASES[name];
    if (!c) {
      console.error("[try-tool] 未知用例：" + name);
      process.exit(2);
    }
    process.stdout.write("[try-tool] " + name.padEnd(18) + " ");
    let result;
    try {
      result = await tool.execute({ ...withWorkspace(c.args), context: { sessionPath: null, messageId: null, messageText: null } });
    } catch (e) {
      console.log("✗ 抛异常：" + ((e && e.message) || e));
      fail += 1;
      continue;
    }
    const ok = c.check(result);
    if (ok) {
      pass += 1;
      console.log("✓");
    } else {
      fail += 1;
      console.log("✗ 输出不符预期：\n" + text(result).slice(0, 600));
    }
  }

  if (typeof dispose === "function") dispose();
  fs.rmSync(dataDir, { recursive: true, force: true });

  console.log("");
  console.log("[try-tool] " + pass + " 通过、" + fail + " 失败");
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("[try-tool] 未捕获异常：" + ((e && e.stack) || e));
  process.exit(1);
});
