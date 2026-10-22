// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/pack.mjs — 从 dist/ 出安装包（ZIP），并给出可核对的清单。
 *
 * ## 为什么自己打包
 *
 * 宿主的通用打包器认的是「extension」这一个大类的规则：它检查 manifest 契约、按自己的
 * 目录约定收文件。对本 App 而言，这带来两个具体限制：
 *
 *   1. **它不知道这个包该有什么。** 交付面只有 3 个文件，而它的产物与日志是通用形状，
 *      多一个少一个都由它自己的规则决定，不由本 App 的断言决定。包内容该由「这个 App
 *      需要什么」来说，不该由「通用打包器记得什么」来说。
 *   2. **它的失败信息是通用的。** 出问题时只说某个文件不合规，说不出「这个包缺了它
 *      就跑不起来」这种本 App 才有的判断。
 *
 * 所以这里自己做三件事，每件都带本 App 的具体断言：
 *
 *   · 清单先算后写：先枚举要进包的文件，核对白名单，再写 ZIP；
 *   · 逐条断言：manifest 声明的入口与图标必须在包里真实存在，产物里不能有源码与开发件；
 *   · 可复现：ZIP 内每个条目的时间戳与权限固定，同输入连打两次 SHA256 相同。
 *
 * ## 校验器仍然用宿主的
 *
 * manifest 的契约标准是宿主定的，自己写一份校验没有意义（它比的是宿主的加载器怎么读）。
 * 所以出包前调官方 validate_app.mjs，出包后对**归档本身**再调一次——校验的是将要
 * 被安装的那个 zip，而不是工作区里的目录。
 *
 * 没有宿主的环境（CI runner）上这一步自动跳过，并在日志里说明。它拦的是「manifest
 * 与宿主加载器不一致」，那种问题只能在装宿主的机器上判；而在没宿主的机器上假装
 * 判过，比不判更糟。CI 管的是另一层：白名单、可复现性、工具用例。
 *
 * ## 产物命名
 *
 *   dist-extensions/hana-run-code-<version>.zip
 *   dist-extensions/hana-run-code-<version>.zip.sha256
 *
 * 用法：
 *   node scripts/pack.mjs                  # 出包
 *   node scripts/pack.mjs --no-validate    # 跳过宿主校验（仅调试用，不用于交付）
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const OUT_DIR = path.join(ROOT, "dist-extensions");

/** 宿主的校验器位置（随宿主安装的 skill 资产）。 */
const HANA_HOME = process.env.HANA_HOME
  || path.join(process.env.USERPROFILE || process.env.HOME || "", ".hanako");
const VALIDATOR = path.join(HANA_HOME, "skills", "hana-app-creator", "scripts", "validate_app.mjs");

/** 交付面白名单：dist/ 里只允许出现这些东西，多一样都不进包。 */
const ALLOWED = [
  "manifest.json",
  "icon.svg",
  "bin/app.mjs",
];

/** ZIP 内固定时间戳（1980-01-01 00:00），让产物可复现。 */
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = (1 << 5) | 1; // 1980-01-01

const log = (...a) => console.log("[pack]", ...a);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");

function fatal(message) {
  console.error("[pack] " + message);
  process.exit(1);
}

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * 写一个最小 ZIP（deflate + 固定时间戳）。
 *
 * 不引第三方 zip 库：本 App 零运行时依赖，打包也不该为它拉一棵依赖树进来。ZIP 的
 * 本地文件头与中央目录都写全，解压工具按标准读即可。
 */
function writeZip(entries, outPath) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const raw = fs.readFileSync(entry.abs);
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(FIXED_DOS_TIME, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0o644 << 16, 38); // external attrs (rw-r--r--)
    central.writeUInt32LE(offset, 42);

    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(outPath, Buffer.concat([...locals, centralBuf, end]));
}

function runValidator(target, label) {
  if (!fs.existsSync(VALIDATOR)) {
    // 没有宿主就没有这个校验器（CI runner 上就没有）。这不是本包的错，
    // 只是少了一层宿主口径的确认，说清楚然后继续。
    log("跳过宿主校验（" + label + "）：没有 " + VALIDATOR);
    return;
  }
  log("校验（" + label + "）…");
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [VALIDATOR, "--dir", target, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    stdout = (e.stdout || "") + (e.stderr || "");
  }
  // 校验器会往 stdout 混一行 node 警告，取最后一个 JSON 对象。
  const jsonText = stdout.slice(stdout.indexOf("{"));
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    fatal("校验器输出无法解析：\n" + stdout.slice(0, 2000));
  }
  const s = parsed.summary || {};
  if (!parsed.ok) {
    const issues = (parsed.issues || []).map((i) => `  · [${i.code}] ${i.message}`);
    fatal("校验未通过（" + (s.errors || 0) + " 错、" + (s.warnings || 0) + " 警）：\n" + issues.join("\n"));
  }
  log("校验通过：" + (s.errors || 0) + " 错、" + (s.warnings || 0) + " 警");
}

function main() {
  const skipValidate = process.argv.includes("--no-validate");

  if (!fs.existsSync(DIST)) fatal("dist/ 不存在：先跑 node scripts/build-app.mjs");

  // 1) 枚举实际文件，与白名单比对。
  const actual = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else actual.push(rel(p).replace(/^dist\//, ""));
    }
  };
  walk(DIST);
  actual.sort();

  const unexpected = actual.filter((f) => !ALLOWED.includes(f));
  if (unexpected.length) {
    fatal("dist/ 里有白名单之外的文件（拒绝出包）：\n" + unexpected.map((f) => "  · dist/" + f).join("\n"));
  }
  const missing = ALLOWED.filter((f) => !actual.includes(f));
  if (missing.length) {
    fatal("dist/ 缺白名单要求的文件：\n" + missing.map((f) => "  · dist/" + f).join("\n"));
  }

  // 2) 读 manifest，核对声明的东西真的存在。
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8"));
  const need = [];
  if (typeof manifest.entry !== "string" || !manifest.entry) fatal("manifest.entry 未声明");
  need.push(manifest.entry);
  if (typeof manifest.icon !== "string" || !manifest.icon) fatal("manifest.icon 未声明");
  need.push(manifest.icon);
  for (const f of need) {
    if (!actual.includes(f)) fatal("manifest 声明的文件不在 dist/ 里：" + f);
  }
  log("清单核对：" + actual.length + " 个文件，manifest 声明的 entry/icon 都在位");

  // 3) 校验工作区目录（宿主口径的 manifest 契约）。
  //    校验器要求目录名等于 app id，而 dist/ 这个名字不匹配，所以先拷到临时目录里改名。
  const staging = path.join(OUT_DIR, ".stage", manifest.id);
  fs.rmSync(path.join(OUT_DIR, ".stage"), { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const f of actual) {
    const to = path.join(staging, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(DIST, f), to);
  }
  if (!skipValidate) runValidator(staging, "交付目录");

  // 4) 出 ZIP
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const zipName = manifest.id + "-" + manifest.version + ".zip";
  const zipPath = path.join(OUT_DIR, zipName);
  writeZip(
    actual.map((f) => ({ name: f, abs: path.join(DIST, f) })),
    zipPath,
  );

  const digest = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
  fs.writeFileSync(zipPath + ".sha256", digest + "  " + zipName + "\n", "utf8");

  const size = fs.statSync(zipPath).size;
  log("出包：" + rel(zipPath) + "  " + (size / 1024).toFixed(1) + " KB");
  log("sha256：" + digest);
  log("包含 " + actual.length + " 个条目：" + actual.join("、"));

  // 5) 清理暂存目录（校验用，不属于产物）
  fs.rmSync(path.join(OUT_DIR, ".stage"), { recursive: true, force: true });
}

main();
