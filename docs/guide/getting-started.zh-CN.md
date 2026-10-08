# 首次运行、目录布局与诊断

[English](getting-started.md) | 简体中文

[文档导航](../README.zh-CN.md) · [构建与安装](install.zh-CN.md) · [第一个任务](quickstart.zh-CN.md)

## 启动独立实例

先完成源码构建，然后从仓库根目录执行：

```sh
export AGH_HOME="$(mktemp -d /tmp/agh-home-XXXXXX)"
export AGNES_PROFILE=local-dev
node agnes.mjs serve
```

已安装的完整发行包使用 `agh serve`；请保留配套原生辅助程序。终端输出本地 URL、运行目录、配置档及诊断摘要，打开实际输出的 URL。其他终端复用相同环境，不要再次执行 `mktemp` 创建另一个实例。`AGNES_LOCALE=zh-CN` 控制 CLI 中文消息；Web 有独立语言偏好。

没有已保存的模型账户和历史会话时，Web 提供五步引导：欢迎、添加并测试账户、选择默认模型、按需浏览官方示例、开始会话。账户配置复用设置页面，密钥私有保存；测试会连接所选提供方，可能产生费用。示例仍经过能力审阅、信任和启用，打开目录不授予权限。默认值只用于新会话。每一步都可以跳过，使用本地演示模型，稍后回设置配置。跳过偏好按当前浏览器中的运行目录和配置档隔离。

## 一套有版本的运行目录

`agh home info` 输出只读 JSON，不创建目录，也不导入其他产品的运行目录。`AGH_HOME` 必须是绝对路径，默认 `~/.agh`。下表定义唯一支持的布局及各职责的路径。

| 职责 | AGH_HOME 下的路径 |
| --- | --- |
| 布局版本与实例标识 | `home-layout.json`，版本 1 |
| 配置档与配置 | `profiles/PROFILE/` |
| 凭据 / OAuth | `secrets/` / `auth/` |
| Ledger 与会话数据 | `data/` |
| 已安装插件包 | `data/profiles/PROFILE/packages/` |
| 运行时代际 | `profiles/PROFILE/.runtime-generations/` |
| 日志与审计 | `data/audit/` |
| 脱敏错误诊断 | `diagnostics/errors.jsonl` |
| 缓存 | `cache/` |
| 运行时临时文件 | `tmp/` |

运行时创建缺失的管理目录，已安装插件目录只由 PackageManager 创建。新实例启动只创建缺失目录，权限 0700；版本标记权限 0600。已有权限只检查，不静默修复。凭据与配置文件需要 0600。插件代码有独立的可执行权限要求，诊断不会递归修改插件权限。显式配置的 dataDir 覆盖仍保留原语义；`home info` 展示约定布局，不代替这些覆盖值。

首次启动的运行目录必须不存在或为空。非空目录缺少版本标记，或标记版本不受支持时，会显示本地化提示并拒绝启动。请通过 AGH_HOME 选择新的私有空目录。检查及拒绝操作不会修改已有文件。

## 查看诊断

```sh
agh doctor --json
agh doctor --probe --json
```

默认检查 Node、原生辅助程序、布局、权限、凭据存储、沙箱边界、daemon 连接、磁盘空间、模型配置、插件完整性和本地 MCP 隔离准备状态。每项提供 `ok` / `warn` / `fail` 及稳定的本地化修复提示键；存在失败项时退出码为 1。只输出元数据，不输出密钥、提供方端点或异常正文。

默认诊断不会连接模型服务。`--probe` 明确测试已启用账户，共享 45 秒超时并支持取消，可能产生费用。原有 `doctor provider --probe` 最小推理和具名诊断仍可用。Linux 的 bubblewrap / Landlock 细节见 `doctor platform`，安装二进制不等于隔离可用。MCP 准备状态不证明某个服务的信任、配置档或连接成功。

Web 将失败项显示为可关闭提示，详情在**设置 → 诊断 → 自检**。“重新检查”读取本地状态；“测试模型账户”才连接提供方。诊断失败不阻止跳过引导。遇到 socket、端口、目录或凭据问题，继续看[排错](troubleshooting.zh-CN.md)。

合同：[App Server](../reference/app-server.zh-CN.md)；实现：[目录布局](../../packages/host-common/src/home-layout.ts)、[运行诊断](../../packages/host-infrastructure/src/doctor.ts)。
