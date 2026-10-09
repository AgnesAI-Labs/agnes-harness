# 安装与源码构建

[English](install.md) | 简体中文

[文档导航](../README.zh-CN.md) · 下一步：[模型配置与首次运行](quickstart.zh-CN.md)

从源码构建后，你会得到一套包含 CLI、后台和 Web 工作台的本地运行目录。按本页准备环境、完成构建，再进入[首次运行](quickstart.zh-CN.md)。想先看预期结果，可以阅读[演示指南](demo.zh-CN.md)。

从本仓库安装仍使用源码构建。下面的 npm 包是发布候选，还没有发布到注册表。

<a id="npx"></a>

## 一行启动（首次 npm 发布之后）

| 选择 | 取值 |
| --- | --- |
| 公共包名 | `@agnes/harness` |
| 命令 | `agh` |
| 版本方案 | `0.1.0-alpha.N`（当前候选为 `0.1.0-alpha.0`） |
| Node.js | `>=24.10` |
| 平台 | macOS arm64 与 x64、Linux arm64 与 x64、Windows x64 |

`agh web` 和 `agh start` 会启动 daemon、worker 和 Web 工作台。**仅供首次 npm 发布之后使用：**下面的注册表命令当前不可用。届时干净的机器可以运行：

```sh
npx @agnes/harness web
```

在发布之前，不要对注册表执行这条命令。安装包带有打包平台的原生预编译文件（`dist/prebuilds/<platform>-<arch>/`），以及打好的 daemon、worker、Web 资源、内置插件、LICENSE 和 NOTICE，安装时没有 workspace 依赖。在源码目录中构建候选包：

```sh
pnpm --filter @agnes/cli pack:npx
```

命令会打印交给 `npm pack` 的目录。仓库里的工作区包名仍是 `@agnes/cli`。

## 获取源码

项目公开入口为 [AgnesAI-Labs/agnes-harness](https://github.com/AgnesAI-Labs/agnes-harness)。从该仓库的 Code 菜单复制克隆地址，或运行：

```sh
git clone https://github.com/AgnesAI-Labs/agnes-harness.git
cd agnes-harness
```

已有源码的开发者直接进入对应 checkout；下面命令均在包含根 `package.json` 的目录执行。

## 环境

| 项目 | 要求 |
| --- | --- |
| Node.js | `>=24.10`；已记录的验证环境见[验证记录](../maintainers/verification.zh-CN.md) |
| pnpm | `10.34.5`，见根 `packageManager`；可以通过 Corepack 调用 |
| macOS | 构建原生 helper 需要 Xcode Command Line Tools；命令沙箱使用 Seatbelt |
| Linux | 命令工具需要 bubblewrap 和可用的 user namespace；仅存在 bwrap 文件不代表可用 |
| Windows | Node 同版本 headers/import library、Visual Studio C++ Build Tools 与 Windows SDK；平台限制见后文 |

在仓库根先检查：

```sh
node --version
corepack pnpm --version
pnpm install --frozen-lockfile
pnpm --filter @agnes/cli build:local
node agnes.mjs --help
```

没有可用的 `pnpm` 命令时，把下文 `pnpm` 换成 `corepack pnpm`。根目录没有 `pnpm build` 脚本；完整运行目录由 CLI 包的 `build:local` 构建。

输出位于 `packages/cli/dist/local/`，包括 `agnes.mjs`、daemon、worker、Web 与平台所需辅助资源。搬运时保持整个目录，不要只复制入口文件。`@agnes/web build` 仅构建 Web，不能替代完整本地分发。

Linux 可由系统包管理器安装 bubblewrap（例如 Debian/Ubuntu 的 `apt install bubblewrap`）；若运行环境禁用 user namespace，默认沙箱会拒绝命令工具，见[排错](troubleshooting.zh-CN.md)。

<a id="linux-build"></a>

## 在 Linux 构建与验证

准备 Node 及其对应的 `include/node/node_api.h` 头文件、C/C++ 工具链、Python 3 和 Git。Debian/Ubuntu 示例：

```sh
sudo apt-get update
sudo apt-get install -y build-essential libssl-dev python3 git bubblewrap
pnpm install --frozen-lockfile
pnpm --filter @agnes/host build:native
pnpm --filter @agnes/system-node build:native
pnpm --filter @agnes/cli build:local
node agnes.mjs doctor
```

PTY relay 链接 `libutil`，system helper 使用 Linux 内核接口与系统 OpenSSL 3 `libcrypto`，从同一已打开文件句柄计算 artifact 摘要。构建时安装 OpenSSL 开发头文件，搬运运行目录时仍须安装匹配的共享库。更换 Node 或架构后须重建 helper，安装 npm 依赖不能替代原生构建。

Linux L1 命令隔离使用 bubblewrap，并验证文件、进程与网络的完整边界。版本检查或可用的 Landlock ABI 不能证明隔离有效：目前 Landlock 仅用于诊断，并非 AGH 命令后端。用户命名空间限制（包括容器 seccomp 或发行版安全策略）可能阻止 bubblewrap 运行。默认在 L1 不可用时拒绝命令；明确选择 **full-access** 后，命令不受操作系统隔离。不要为消除诊断而绕过锁或修改系统安全策略。

凭据使用归当前用户所有的私有目录（`0700`）与文件（`0600`），无需桌面 secret-service。当前 Computer Use 不支持 Linux：固定驱动尚无通过准入的 Linux 平台证据，仅安装图形桌面不能启用。PTY 与 Web 工作台不依赖桌面。

本地 Web gate 首次使用前安装固定版本浏览器及系统库，再运行离线 fixture 套件：

```sh
pnpm exec playwright install --with-deps chromium
pnpm e2e:web
```

准备依赖时使用网络；gate 使用缓存 Chromium、全新隔离 home 和本地模拟服务。已评审 Linux 基线与 macOS 基线分别保存，详见[维护中的 gate](../../tools/e2e-web/README.md)。

## Windows 构建

先安装依赖，在同一个 PowerShell 会话中运行：

```powershell
$ErrorActionPreference = 'Stop'
& .\.github\scripts\prepare-windows-native.ps1 -CacheRoot "$env:LOCALAPPDATA\node-gyp\Cache"
if ($LASTEXITCODE -ne 0) { throw 'Node headers unavailable' }
pnpm.cmd --filter @agnes/cli build:local
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
node .\packages\cli\dist\local\agnes.mjs --help
```

headers 准备需要网络和包含 npm 的 Node 安装。升级 Node 后应重建原生 helper。Windows 已有构建与部分验收代码。文档中的 PowerShell 示例尚未在 Windows 实机执行；符号链接、受限 token、网络沙箱、安装升级及签名仍需分别验证。已记录的本地进程验证平台为 macOS。

## 独立试用目录

开始文档实验时用独立绝对路径，避免连接已有实例。POSIX shell：

```sh
export AGH_HOME="$(mktemp -d /tmp/agh-docs.XXXXXX)"
export AGNES_PROFILE=local-dev
node agnes.mjs daemon status
node agnes.mjs serve
```

PowerShell：

```powershell
$env:AGH_HOME = Join-Path ([IO.Path]::GetTempPath()) ('agh-docs-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $env:AGH_HOME | Out-Null
$env:AGNES_PROFILE = 'local-dev'
node .\packages\cli\dist\local\agnes.mjs serve
```

普通长期使用可以不设置 `AGH_HOME`，默认是 `~/.agh`。每个规范化 AGH_HOME 只有一个后台；配置档和 dataDir 必须与运行实例一致。不同项目目录不是自动隔离的账号或后台。Unix socket 路径有限，实验 home 尽量短。默认 socket 路径过长时，后台会选择经过身份与权限校验的短临时目录；显式指定的 socket 路径过长时仍会拒绝启动。

## 重建与版本切换

不要覆盖正在运行的分发目录，尤其是 Windows 原生 DLL 被占用时。可以先在新的输出目录构建：

从源码仓库根目录执行。`--output-dir` 必须是绝对路径；pnpm 的 `--filter` 会改变脚本工作目录，不能传仓库相对路径。POSIX shell（每次创建新的输出位置）：

```sh
AGH_BUILD_ROOT="$(mktemp -d /tmp/agh-build.XXXXXX)"
corepack pnpm --filter @agnes/cli build:local --output-dir "$AGH_BUILD_ROOT/runtime"
node "$AGH_BUILD_ROOT/runtime/agnes.mjs" --help
```

PowerShell（同样从源码仓库根执行）：

```powershell
$aghBuildRoot = Join-Path ([IO.Path]::GetTempPath()) ('agh-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $aghBuildRoot | Out-Null
$aghBuildOutput = Join-Path $aghBuildRoot 'runtime'
corepack.cmd pnpm --filter @agnes/cli build:local --output-dir $aghBuildOutput
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
node (Join-Path $aghBuildOutput 'agnes.mjs') --help
```

上述 POSIX 构建流程已有按版本保存的运行证据；PowerShell 示例仅核对了参数与路径构造。环境与结果见[验证记录](../maintainers/verification.zh-CN.md)。

在原实例结束任务后，用原分发的入口显式 `daemon stop`，结束旧 Web 服务，再启动新分发。构建锁、失败暂存目录和 owner 记录属于恢复证据，不能用删除它们来掩盖构建或后台问题。没有自动安装、自动更新或开机启动承诺。

实现依据：[工具链](../../package.json)、[本地构建](../../packages/cli/tools/build-local.ts)、[npx 包](../../tools/release/pack-npx.ts)、[Windows headers](../../.github/scripts/prepare-windows-native.ps1)。
