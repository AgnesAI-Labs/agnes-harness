# 安装与源码构建

[English](install.md) | 简体中文

[文档导航](../README.zh-CN.md) · 下一步：[模型配置与首次运行](quickstart.zh-CN.md)

从源码构建后，你会得到一套包含 CLI、后台和 Web 工作台的本地运行目录。按本页准备环境、完成构建，再进入[首次运行](quickstart.zh-CN.md)。想先看预期结果，可以阅读[演示指南](demo.zh-CN.md)。

当前分发方式为源码构建，尚无正式公共安装包。

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
node packages/cli/dist/local/agnes.mjs --help
```

没有可用的 `pnpm` 命令时，把下文 `pnpm` 换成 `corepack pnpm`。根目录没有 `pnpm build` 脚本；完整运行目录由 CLI 包的 `build:local` 构建。

输出位于 `packages/cli/dist/local/`，包括 `agnes.mjs`、daemon、worker、Web 与平台所需辅助资源。搬运时保持整个目录，不要只复制入口文件。`@agnes/web build` 仅构建 Web，不能替代完整本地分发。

### 可选：使用 mise 管理项目工具链

如果使用 [mise](https://mise.jdx.dev/)，仓库的 `mise.toml` 会固定开发用的 Node 和 pnpm 版本，不改变其他项目或全局 Node 安装。pnpm 版本应与 `package.json` 的 `packageManager` 保持一致；Node 的 engine 范围仍是兼容性要求。

先审阅项目配置，再在仓库根目录运行：

```sh
mise trust
mise install
mise exec -- node --version
mise exec -- pnpm --version
mise exec -- pnpm install --frozen-lockfile
make dev
```

`make dev` 和 `make dev-web` 在 PATH 中找到 mise 时会自动使用 `mise exec --`，无需额外前缀或 shell 自动激活。未安装 mise 时使用当前 Node；仍支持 `make dev NODE=/path/to/node` 和 `ARGS` 覆盖。若 mise 可用但配置或工具执行失败，会直接报告错误，不会回退到其他运行时。项目级 `activate_aggressive` 设置确保所选工具在 PATH 中优先。本页其他 Node/pnpm 命令可以加 `mise exec --` 前缀；如果 shell 已为当前项目激活 mise，则可直接运行。mise 不是必需依赖，单独准备满足上述要求的工具链仍可使用。运行时安装目录和长期使用的 AGH home 应放在临时目录之外。

### 本地开发快捷重启（macOS / Linux）

安装依赖并准备好上述工具链后，在仓库根目录运行：

```sh
make dev
```

默认端口为 `4189`。命令先在新的目录构建完整前后端，成功后停止旧 daemon 和 Web，再启动新分发；构建失败不会停止旧服务。会优先沿用该端口上已核验的 AGH 实例的 home、profile、dataDir 和工作区，随后使用此 checkout 保存的选择；首次启动无记录时使用 `AGH_HOME`（未设置则 `~/.agh`）、`local-dev` 和当前仓库。Node 默认使用启动器进程的运行时，覆盖优先级为 `--node`、`AGH_DEV_NODE`；历史实例的 Node 路径不会覆盖当前项目工具链。不会清空会话或 comparison 数据。重启会中断执行中的任务。

```sh
make dev ARGS='--check'                 # 只读检查将使用的实例
make dev ARGS='--port 4190 --home /tmp/agh-dev --cwd /path/to/project'
make dev ARGS='--node /path/to/node --env-file /private/path/dev.env'
```

`make dev-web` 是同一入口的别名。需要 `make`、`lsof` 和 `ps`；Windows 使用现有 `start-local-windows.ps1`。新进程继承启动终端的环境；`--env-file` 可补充配置。默认还会加载所选 home 下的 `dev.env`，已有环境变量优先。首次运行 `make dev ARGS='--save-env'` 可将当前终端的 `AGNES_JEV_*` 和 `TYPESAFE_API_KEY` 保存到该文件（`0600`、拒绝覆盖，不保存其他变量）；自动加载拒绝非白名单字段、符号链接及其他用户可读的文件。请将 home 放在仓库外，勿提交凭据。启动器不会读取或复制旧进程的密钥。`Ctrl+C` 结束本次 Web 和对应后台；源码变更后再次运行 `make dev`，此入口不提供自动监听重建。

新建的 `dataDir/daemon` 目录权限为 `0700`；Unix socket 监听器会拒绝权限不够私密的目录。已有目录权限不会自动修复，调整前应先核查归属和权限。

非 AGH 端口占用、作用域不符、无法核验进程身份或另一个启动器正在切换时会拒绝停机。互斥锁位于所选 `dataDir/daemon/dev-launch.lock`；异常断电等留下的锁需要先核查 owner，不能盲目删除。构建输出保留在 `packages/cli/dist/dev-*/runtime`，实例选择保存在 git 忽略的 `.agnes-tmp/dev/`，其中 Node 路径仅记录上次成功启动的运行时；此命令不清理旧分发目录。

Linux 可由系统包管理器安装 bubblewrap（例如 Debian/Ubuntu 的 `apt install bubblewrap`）；若运行环境禁用 user namespace，默认沙箱会拒绝命令工具，见[排错](troubleshooting.zh-CN.md)。

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
node packages/cli/dist/local/agnes.mjs daemon status
node packages/cli/dist/local/agnes.mjs serve
```

PowerShell：

```powershell
$env:AGH_HOME = Join-Path ([IO.Path]::GetTempPath()) ('agh-docs-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $env:AGH_HOME | Out-Null
$env:AGNES_PROFILE = 'local-dev'
node .\packages\cli\dist\local\agnes.mjs serve
```

普通长期使用可以不设置 `AGH_HOME`，默认是 `~/.agh`。同一 home/profile/dataDir 共享后台；不同项目目录不是自动隔离的账号或后台。Unix socket 路径有限，实验 home 尽量短。默认 socket 路径过长时，后台会选择经过身份与权限校验的短临时目录；显式指定的 socket 路径过长时仍会拒绝启动。

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

macOS 进程身份现在由稳定的启动会话 UUID、PID 和进程启动时间共同组成，避免旧启动时间戳在校时后漂移。
升级前应停止旧实例；身份格式不同，不能只在正在运行的分发目录内替换 native helper。

实现依据：[工具链](../../package.json)、[本地构建](../../packages/cli/tools/build-local.ts)、[Windows headers](../../.github/scripts/prepare-windows-native.ps1)。
