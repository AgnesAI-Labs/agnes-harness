# 代码诊断（LSP）

[English](lsp.md) | 简体中文

Agent 写入或编辑 TypeScript、JavaScript、Python、Go、Rust 文件后，Agnes 会向语言服务器取这个文件的错误，追加到 `write`/`edit` 的结果里，模型在造成类型错误的同一步就能看到它。`lsp_diagnostics` 工具可按需对其他文件做同样的检查。`agnes/lsp` 扩展默认开启。

## 安装语言服务器

Agnes 不会自动下载语言服务器。请自行安装需要的服务器并放到 `PATH` 上；没有对应服务器的语言会被静默跳过。服务器解析和启动所用的 `PATH` 是过滤后的：只保留绝对路径、去重，并去掉位于工作区或会话目录内的条目，这样服务器自己启动的子进程（`node`、`go`、`cargo`）不可能是仓库里的程序。每个服务器只解析一次、只认第一个匹配项，并以其绝对真实路径启动；带 `#!` 的脚本会以 `[解释器, 脚本]` 启动，解释器同样按此规则解析，若在工作区外找不到解释器，该服务器不可用。

| 语言 | 服务器（找到的第一个生效） |
| --- | --- |
| TypeScript、JavaScript | `typescript-language-server`（连同 `typescript` 一起安装） |
| Python | `pyright-langserver`，其次 `basedpyright-langserver` |
| Go | `gopls` |
| Rust | `rust-analyzer`（仅限受信任的工作区，见下文） |

服务器在该语言的文件第一次被编辑时启动，每个会话、每个项目根一个（取最近的 `tsconfig.json`、`pyproject.toml`、`go.mod`、`Cargo.toml` 等标记所在目录，不会超出工作区）。启动期间的第一次编辑不会附带错误，之后的编辑会。每个会话最多 3 个、每个 worker 最多 4 个服务器；达到上限时关闭最久没用的空闲服务器，空闲 10 分钟的服务器也会被关闭。启动失败或退出的服务器，3 分钟内不会重试。

## 模型看到什么

- `write` 或 `edit` 之后：只附被修改文件的错误，最多 20 行、4 KB，格式为 `LSP found N errors in <path>:`，后面每行 `行:列 消息 (来源 代码)`。没有错误时不附加任何内容。最多等 2 秒，服务器更慢就什么也不附。
- `lsp_diagnostics`：`{"paths":["src/a.ts","src/b.ts"],"severity":"error"}`，最多 20 个路径，`severity` 为 `error`（默认）、`warning` 或 `all`。返回汇总和每个文件最多 50 条，并说明某个文件无法检查的原因（未安装服务器、仍在启动、远程沙箱）。
- 子 agent 会话不会在 `write`/`edit` 后自动附带错误（避免大量子 agent 同时占用内存），但可以调用 `lsp_diagnostics`。

## 安全

- 服务器通过会话沙箱运行，和 shell 命令受同一份策略约束：只能访问工作区和已准入的额外目录，`.git` 和密钥目录被拒绝，网络按会话策略。它们只拿到白名单环境变量（`PATH`、`HOME`、`LANG`/`LC_*`、`TMPDIR` 以及 Go、Rust、Python 的位置变量），拿不到任何模型或提供方凭据。
- **只做静态分析。** 启动语言服务器不能成为绕过命令审批、执行工作区代码的途径，所以每个服务器都以不执行代码的模式启动；工具上下文里也没有工作区受信任的信号，因此不使用工作区内的可执行文件（`node_modules/.bin`、`.venv/bin`）。TypeScript 使用 `PATH` 上 `typescript-language-server` 旁边安装的 `tsserver`，且不加载任何插件、不做自动类型获取（不运行 `npm`），所以项目自己的 TypeScript 版本和 tsserver 插件不生效；找不到这样的 `tsserver` 时，TypeScript 报告为不可用。rust-analyzer 会运行 Cargo，而工作区里的 `.cargo/config.toml`（rustc wrapper、构建覆盖）、`rust-analyzer.toml`、`rust-toolchain.toml` 都可能执行或选择代码，所以除非工作区受信任，否则根本不启动；目前工具拿不到信任信号，因此会提示“Rust analysis needs a trusted workspace (it runs Cargo)”。可用时它也不会运行 build script、过程宏、`cargo check` 或 `RUSTC_WRAPPER`。gopls 以 `GOTOOLCHAIN=local`、`GOPROXY=off`、`GOFLAGS=-mod=readonly` 运行：不下载任何东西，也不改写 `go.mod`。Pyright 本身就是静态的。不受信任的工作区不提供完整的项目插件；受信任工作区模式需要 Host 提供目前尚不存在的信任信号。
- Go 和 Rust 的服务器要读取工作区外的模块缓存（`~/go/pkg/mod`、`~/.cargo`）。沙箱拒绝时它们会报不出或报不全错误，我们不会为此放宽沙箱。尚未缓存的依赖不会被下载。
- 远程沙箱没有长驻进程，因此该功能不可用：工具会如实说明，`write`/`edit` 不附加任何内容。

## 关闭

从预设的扩展列表里去掉 `agnes/lsp`，工具和自动错误都会消失，也不会启动任何服务器。上限、等待时间、子 agent 是否附带错误等阈值是扩展的内置默认值；内置扩展目前收不到按插件的配置，也不支持自定义服务器命令。
