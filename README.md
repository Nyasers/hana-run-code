# Hana Run Code

跑一段临时程序，只把结果交回对话。

写它的直接理由是替代 PowerShell 里最容易出问题的那部分：批量遍历文件、算一遍统计、读一堆文档只取结论。这类任务在 pwsh 里要穿过 JSON、shell、程序三层引号，一个 `$` 可能被展开两次，出错时还不报错，悄悄改掉你的内容。

这里的程序正文通过 stdin 直接交给 Node 子进程。中间不经过 shell，不落盘，没有引号被剥掉的余地。

## 能做什么

```ts
// 算出结果用 return 交回，会自动打印
import fs from "node:fs";
import path from "node:path";

interface Row { file: string; kb: number }

const rows: Row[] = fs.readdirSync("src")
  .map((f: string) => ({ file: f, kb: Math.round(fs.statSync(path.join("src", f)).size / 1024) }))
  .sort((a: Row, b: Row) => b.kb - a.kb);

return { total: rows.length, largest: rows.slice(0, 3) };
```

顶层 `await` 可用，`console.log` 进 stdout，`console.error` 进 stderr，两个通道各自截断到 256 KB。

**程序里没有宿主工具**。它不能调 `read`、`grep`、`web_search`，能力只来自 Node 本身（`node:fs`、`node:child_process`、内置模块）。这是它和 PTC 的分界：PTC 是「在代码里调用工具」，这个工具是「让代码代替一连串工具调用」。

## TypeScript

支持 TypeScript，但只支持 **erasable** 语法。Node 擦除类型后直接执行，不做转译：

| 写法 | 结果 |
|---|---|
| 类型注解、`interface`、`type` | 可以 |
| 泛型、`as` 断言、`private` 修饰符 | 可以 |
| `import type` | 可以，整条语句被擦掉 |
| `enum` | 报错 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` |
| `namespace` | 报错 |

想跑 `enum` 就换成 `as const` 对象或联合类型，这本来也是更贴近运行时的写法。

## 沙箱

程序在独立 node 子进程里跑，受 Node Permission Model 约束。默认给两个可读写的地方：

| 档位 | workspace | tmp | 用途 |
|---|---|---|---|
| `workspace`（默认） | 读写 | 读写 | 日常 |
| `readonly` | 只读 | 只读 | 只想读、确认不会改东西 |
| `inherit` | 宿主那套授权 | 宿主那套授权 | 排查「为什么我读不到」 |

`tmp` 指 `os.tmpdir()`（Windows 是 `%TEMP%`，Linux 是 `/tmp`）。默认放行是因为很多库会往里落缓存，少了它只会拿到 `ERR_ACCESS_DENIED`。想验证「完全无处可写」可以传 `sandboxTemp: false`。

工作区之外的路径一律拒绝。子目录会继承父目录的授权，父目录不会继承子目录的。

## 参数

| 参数 | 说明 |
|---|---|
| `code` | 程序正文（ES module，可含 erasable TS） |
| `description` | 一句话说明这段程序做什么。不参与执行 |
| `cwd` | 工作目录，同时是沙箱授权根。缺省为 App 数据目录 |
| `sandbox` | `workspace` / `readonly` / `inherit` |
| `sandboxTemp` | 是否放行系统临时目录，默认 `true` |
| `timeoutMs` | 超时毫秒，默认 30 秒，上限 5 分钟。超时连同子进程树一起终止 |

## 安装

需要 Hana `1.1.35-beta` 或更新。声明了两项能力，安装时要批准：

- `app/tools.expose-to-model` — 工具进模型可调用面
- `app/process.spawn` — 允许起子进程（`run_code` 靠它启动 node）

## 开发

```bash
pnpm install
pnpm build:server    # 打包 src/ → dist/bin/app.mjs
pnpm build           # 组装交付面 dist/（白名单三件）
pnpm pack            # 出 dist-extensions/hana-run-code-<ver>.zip
```

`scripts/dev/try-tool.mjs` 跑 17 个用例，覆盖基础执行、三档沙箱、tmp 开关、TypeScript、超时、返回值边界与输出截断。

**这些用例测不出沙箱本身**。dev 脚本跑在普通 shell 里，那个进程没有权限模型，`existsSync` 看什么都在。沙箱的验收必须在宿主里做，把工具真实调一次，看 `C:/Windows` 是不是 DENY。

## 实现取舍

**程序不落盘。** 程序正文走 stdin（`--input-type=module-typescript`）。往磁盘写脚本要额外授权一个脚本路径，而实测把一个**文件路径**写进 `--allow-fs-read` 会让整串授权失效；改成授脚本目录又会和临时目录这类父目录条目冲突。走 stdin 一次绕开两个问题，顺带没有残留要清理。代价是错误栈里显示 `[eval]` 而不是文件名。

**用宿主自己的 node。** `spawn(process.execPath, ...)`，不做 fallback。宿主是纯 Node 运行时（实测 v26.8.1，非 Electron），用户不需要另外装 node，也不需要猜 `HANA_NODE_RUNTIME`。宿主只会向前更新，`module-typescript` 这类能力不会突然消失。

**子进程，不是 App 内 eval。** 子进程跑完即死，全局污染和内存泄漏带不到下一次调用。App 进程里 eval 会把状态留给下次。

**`--allow-child-process` 是个口子。** 程序能起外部命令，也就意味着它能起一个孙进程在命令行上加 `--allow-fs-read=*` 读到全盘。这是 Node 的固有性质，App 这一层修不了。本工具服务的是本机可信调用方，边界防误伤，不防故意越狱。

## 许可

MPL-2.0，正文见 [LICENSE](LICENSE)，版本归属与源码地址见 [NOTICE](NOTICE)。

MPL 是文件级 copyleft：改过的文件要公开源码，但可以把它链进闭源项目。
