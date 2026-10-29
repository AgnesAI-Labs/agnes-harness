# 从旧版 AGH 升级

[English](upgrade-from-previous.md) | 简体中文

[文档导航](../README.zh-CN.md) · [安装](install.zh-CN.md) · [快速开始](quickstart.zh-CN.md)

本页面向在插件内核版本发布之前，从 `main` 运行过 AGH 的用户。这次按新产品发布：能力由插件组合，智能体有显式启动声明，应用选择自己的展示方式，Web 工作台也已更新。**旧环境不做数据迁移。** 请使用干净的 home，重新配置新产品。

旧会话、定时任务、已安装插件及其信任、运行时代码代际、设置、模型账户和登录状态均不继承。备份只用于保留旧文件供参考，复制进新 home 不会使其兼容。新架构内的插件热更新是另一项能力。

## 保留旧环境会发生什么

新运行时拒绝已退出支持的 `AGNES_HOME` 变量，即使同时设置了 `AGH_HOME`：

```text
E_HOME_INVALID
AGNES_HOME is no longer supported; unset it and set AGH_HOME to a new, empty private directory (clean home).
```

非空 home 缺少受支持的布局标记时，中文错误如下（目录行会显示实际绝对路径）：

```text
E_HOME_VERSION：检测到旧版或未标记的 AGH 运行目录。本版本是新产品，不能使用此布局，也不会迁移旧数据。
旧环境目录：<home 的绝对路径>
请删除或移走此目录后重新启动，或将 AGH_HOME 指向另一个新的私有空目录。已有文件未被修改。
说明：https://github.com/AgnesAI-Labs/agnes-harness/blob/main/README.zh-CN.md#new-product-clean-home
```

无效或不受支持的标记也会报 `E_HOME_VERSION`。不要创建或修改 `home-layout.json` 来绕过检查。

受支持的 home 还有独立的 SQLite 数据门禁。当前 `DATA_DIR_VERSION` 为 **2**。例如非空的格式 1 数据库会报 `E_DATA_DIR_STALE`，原始错误正文如下，路径替换为实际值：

```text
data directory <dataDir> was created by an older AGH (data format 1; this build supports 2). Stop AGH, back up <dataDir>, then delete <dataDir>/sessions.db, <dataDir>/sessions.db-wal, <dataDir>/sessions.db-shm and the directory <dataDir>/tables. Sessions, schedules, workspace bindings and plugin settings are lost; plugins you installed yourself must be reinstalled. Nothing was changed.
```

未标记版本的数据库、已退役的数据表，或存在插件表却缺失账本，也会触发 `E_DATA_DIR_STALE`。`E_DATA_DIR_NEWER` 表示数据由更新的版本写入，应升级 AGH，不要降低版本标记。[数据格式恢复](install.zh-CN.md#数据格式与升级)介绍了仅适用于**受支持 home** 的局部账本重置；它保留 profiles，不是从旧产品迁移的办法。

## 清理之前先定位所有目录

home 优先使用显式 `AGH_HOME`，否则使用 `HOME` 下的 `.agh`，再回落到操作系统用户目录下的 `.agh`。旧版还在 `AGH_HOME` 之后接受 `AGNES_HOME`；取消该变量前先记下旧值。Windows 中自定义的 `HOME` 优先于通常的用户目录回落。下表只是默认值，不能据此删除属于其他产品的同名目录。

| 平台 | 默认 AGH home | 默认数据目录 | 默认 profile 目录 |
| --- | --- | --- | --- |
| macOS | `$HOME/.agh` | `$HOME/.agh/data` | `$HOME/.agh/profiles/local-dev` |
| Linux | `$HOME/.agh` | `$HOME/.agh/data` | `$HOME/.agh/profiles/local-dev` |
| Windows | `%USERPROFILE%\.agh` | `%USERPROFILE%\.agh\data` | `%USERPROFILE%\.agh\profiles\local-dev` |

用户目录不同时，以实际目录为准。`AGNES_PROFILE` 或 `--profile` 可选择其他 profile；备份应包含**全部** profile。以下用 `H` 表示实际 home，`D` 表示配置的数据目录（通常为 `H/data`），`P` 表示 profile 名称：

| 位置 | 内容／删除前应保留的资料 |
| --- | --- |
| `H/profiles/P/` | Profile YAML、`configuration.json`、插件锁、配置与信任元数据；`.runtime-generations/` 保留组合后的代码代际 |
| `D/sessions.db`、`D/sessions.db-wal`、`D/sessions.db-shm`、`D/tables/` | 会话账本与插件持久状态，包括定时任务和设置；停止后备份整个 `D` |
| `D/profiles/P/packages/`、`D/profiles/P/.runtime-snapshots/` | 已安装插件文件与保留的插件快照 |
| `H/plugins/` | 运行时发现的用户插件源码；自行编写的代码另行保留，并按新 API 复核 |
| `H/secrets/`、`H/auth/` | 凭据与认证状态；备份保持私有，账户需重新配置 |
| `D/audit/`、`H/diagnostics/` | 审计／运行日志和诊断；shell 重定向也可能把日志写在其他位置 |
| `H/daemon/`、`H/cache/`、`H/tmp/`、`H/terminal-sessions/`、`H/memory/` | 后台身份与发现、缓存、临时文件、终端会话选择和学习记忆 |
| `H/sessions.db` 及其附属文件（若存在） | 历史 home 根目录账本；备份整个 home 时一并包含 |
| `PROJECT/.agh/` | 工作区部署／配置、插件、Skills 和 hook 文件；位于 home 之外，也可能影响新运行时 |

Profile 的 `dataDir`、`cacheDir` 或 `adapters.secrets.path` 可以指向 `H` 外。检查旧 profile 和启动参数（包括 `--data-dir`），分别备份这些**精确的外部位置**。仅移走 `H` 不会移走它们。不要删除共享目录或项目源码。代码不会自动回落到 `~/.agnes`；只有明确把它配置为本 AGH 实例的 home 时才处理该目录。

## 停止、备份并移除旧环境

1. 完成或取消旧任务，在运行旧 Web／`serve` 的终端按 Ctrl+C。停用自己配置的启动包装脚本，避免实例自动重启。
2. **使用旧分发**，保持原来的 home、profile 和数据目录覆盖，依次运行 `daemon status`、`daemon stop`，再运行 `daemon status` 确认。在旧源码目录中对应 `node agnes.mjs daemon status` 和 `node agnes.mjs daemon stop`；已安装的旧 CLI 使用 `agh daemon …`。可通过 `--home /absolute/old-home --profile PROFILE` 指定精确实例；原来用了数据目录覆盖时，加上 `--data-dir /absolute/old-data`。不要用拒绝旧布局的新运行时停止旧实例。如果身份校验拒绝，保留文件并按[排错指南](troubleshooting.zh-CN.md)处理，不要删除正在运行的 daemon 的锁。
3. 确认停止后，把旧 home 移到备份名称。这既从活动路径移除环境，又保留全部文件，包括隐藏文件。以下示例要求填写刚刚核实的路径，已有同名备份时不执行移动。

macOS / Linux（POSIX shell）：

```sh
agh_old_home='/absolute/path/to/old-home'
agh_backup="${agh_old_home}.before-plugin-kernel"
test -d "$agh_old_home" && test ! -e "$agh_backup" && mv -- "$agh_old_home" "$agh_backup"
unset AGNES_HOME
unset AGH_HOME
unset AGNES_PROFILE
```

Windows（PowerShell）：

```powershell
$aghOldHome = 'C:\absolute\path\to\old-home'
$aghBackup = "$aghOldHome.before-plugin-kernel"
if (!(Test-Path -LiteralPath $aghOldHome -PathType Container)) { throw 'Old home not found' }
if (Test-Path -LiteralPath $aghBackup) { throw 'Backup already exists' }
Move-Item -LiteralPath $aghOldHome -Destination $aghBackup -ErrorAction Stop
Remove-Item Env:AGNES_HOME, Env:AGH_HOME, Env:AGNES_PROFILE -ErrorAction SilentlyContinue
```

备份包含凭据和对话，须保持私有。确认移动成功后再继续。专用的外部数据／缓存／凭据目录分别用不同备份名称按同样方式移动。在每个使用过旧产品的工作区，备份并移走**仅该项目的 `.agh` 文件夹**，例如改为 `.agh.before-plugin-kernel`。自行编写的插件／Skill 应复核后再主动引入，不要复制旧部署、锁或信任文件。保留项目其他内容。`.agents/skills` 等共享 Skill 根目录不是应删除的 AGH 环境数据。

还需从自己配置的 shell 启动文件、启动脚本或 Windows 持久环境设置中移除旧 `AGNES_HOME` 及旧路径覆盖。上述取消变量只影响当前 shell。若保留备份并使用自定义路径，将 `AGH_HOME` 设为**另一个尚未使用的绝对路径**，不要恢复旧值。让 AGH 自行创建目录，尤其在 Windows 上由它建立私有 ACL。

检查备份且确定不再需要后，可选择永久删除。在同一 shell、变量仍保留的情况下，仅删除已核实的备份：macOS/Linux 用 `rm -rf -- "$agh_backup"`，Windows 用 `Remove-Item -LiteralPath $aghBackup -Recurse -Force`。不要对新 home 或项目根目录运行这些命令。

## 安装并重新开始

按[安装指南](install.zh-CN.md)使用固定工具链构建新 revision，再按[快速开始](quickstart.zh-CN.md)运行 `node agnes.mjs serve`，打开打印的地址。源码预览不承诺已有公开 npm 安装器。Windows 仍没有完成端到端验收，也没有已验证的 L1 命令沙箱，见[平台限制](../reference/limitations.zh-CN.md)。

重新添加模型账户与凭据、选择默认模型、安装并审查插件，重建需要的设置、工作区登记和自动化任务。可以用[本地 Demo](demo.zh-CN.md)先检查新环境，无需付费模型。新历史中不会出现旧会话。

需要帮助时，提交[问题报告](https://github.com/AgnesAI-Labs/agnes-harness/issues/new?template=bug_report.yml)，附旧／新 revision、操作系统、Node 版本和准确错误码。只分享脱敏摘录，不要上传 home 备份或凭据。安全问题按 [SECURITY.md](../../SECURITY.md)报告。

实现依据：[home 解析](../../packages/host-common/src/paths.ts)、[home 布局](../../packages/host-common/src/home-layout.ts)、[拒绝文案](../../packages/host-common/src/home-message.ts)、[profile 解析](../../packages/host-common/src/profile/resolve.ts)、[daemon 范围](../../packages/daemon/src/supervisor/scope.ts)、[数据门禁](../../packages/host-infrastructure/src/adapters/storage-sqlite-data-dir.ts)、[插件快照](../../packages/package-manager/src/runtime-snapshots.ts)、[本地插件](../../packages/package-manager/src/local-source.ts)。
