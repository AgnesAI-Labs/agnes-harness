# 排错：找到下一步可以检查的事

[English](troubleshooting.md) | 简体中文

[文档导航](../README.zh-CN.md) · [已知限制](../reference/limitations.zh-CN.md)

先分辨问题发生在构建、连接、模型配置还是插件运行，再选对应的检查。表格中的步骤尽量保留现场，方便定位原因。

先记下当前 commit、Node 版本、命令、错误码与所用 home/profile；不输出整个环境或凭据。下面的诊断默认仍使用你选定的隔离 AGH_HOME。

```sh
node packages/cli/dist/local/agnes.mjs --version
node packages/cli/dist/local/agnes.mjs daemon status
node packages/cli/dist/local/agnes.mjs doctor platform --json
node packages/cli/dist/local/agnes.mjs doctor storage --json
node packages/cli/dist/local/agnes.mjs doctor provider --json
```

`doctor storage` 会建立并清理临时探测数据库；它不修复现有数据。`doctor provider --probe` 则会调用模型，排错时不要无意添加。

| 现象 | 核对与处理 |
| --- | --- |
| Node 太旧/SQLite 模块错误 | 确认 Node >=24.10；默认 shell 与构建使用的 Node 可能不同 |
| 缺少 `dist/local/agnes.mjs` | 在仓库根运行完整 `build:local`；不是 daemon stop 能修复的问题 |
| native helper 缺失/不兼容 | 保留完整分发，按当前 OS/架构/Node 重建；不复制其他平台的单文件 |
| `listen EPERM` | 执行环境禁止 socket/回环监听；测试需允许相应权限，不通过修改产品安全策略绕过 |
| daemon 启动后马上退出 / `E_DAEMON_SOCKET_PATH` | 核对 helper、版本及 home/profile。可用短 `/tmp/agh-*` 实验 home 排除路径因素；当前源码对过长默认 socket 路径有短目录回退，但过长显式路径、目录身份或权限不合格仍会拒绝 |
| 端口占用 | 先确认哪个实验 Web listener 持有它，再结束自己启动的服务或换端口 |
| Origin/Host 不匹配 | 地址与 `AGNES_WEB_ORIGIN` 严格一致，不混用 localhost/127.0.0.1；旧后台不同配置时显式停止对应实例 |
| 页面问 token/文档要求复制 token | 检查是否混用旧 build/旧说明；当前本地 Web 打印普通 URL |
| 缺 Provider / 非法 route/model | 运行 config 或 Web 设置，测试保存后从当前目录选模型；新默认不修改旧会话 |
| `SANDBOX_UNAVAILABLE` | Linux 检查 bwrap 的真实执行及 user namespace，macOS 检查系统沙箱可用性；不可用时保留拒绝 |
| 插件安装成功却没有工具 | 看 trusted、desired、actual、行错误、依赖和 manifest；单独旧 `agnes.extensions` 不是现行普通后端插件入口 |
| 前端 v2、后端仍旧或 unavailable | 核对同包 anchor、web row、services ceiling/allow-list、当前会话与 runtime revision |
| package/resource 操作超时 | 用返回的 operation ID 查询；超时不代表已取消 |
| Skill 找不到或被 shadow | 看来源根、会话工作区、修订、trust/desired/actual、winner/stale；刷新相应根 |
| 找不到 Skills 删除或优先级操作 | 使用 Web 管理页或 Node SDK；shell/TUI 没有对应命令。若管理页也缺少入口，核对前端与后台是否来自同一份完整构建 |
| Skill 优先级已保存却不可用 | 检查 winner 的自身 trust/desired；数值改变不授予权限，保存冲突需刷新 revision 与 expectedPriority |
| Skill 删除失败/不能重新启用 | 检查 operation 与 SKILL_REMOVAL_PENDING；可能已有部分文件删除，排除占用后显式重试，不能靠重启/刷新当作撤销 |
| MCP 目录为空或不能调用 | 检查定义 revision、信任、期望启用、连接状态、tool allow-list 与可执行程序策略；当前逐服务器会话路径跳过 OAuth 绑定，管理面测试成功不能证明会话可调用 |
| 工具报 E_LEASE_EXPIRED | 检查当前行是否已卸载、撤权或被新版本替换，并核对运行产物版本；旧版本曾有默认 24 小时到期问题，详见[支持范围](../reference/limitations.zh-CN.md)。保留会话与错误，按实际状态重新加载 |
| 浏览器断线/停止后仍运行 | 关闭客户端与取消/停止后台不同；根据后台历史确认最终状态 |
| 导入失败 | 保留输入和错误，用脱敏最小夹具复现；不要直接改数据库 |

意外 daemon 错误可能附 `diagnosticId`；用它匹配所选 dataDir 下 `audit/daemon.jsonl` 的记录。审计写入失败时可能返回 `diagnosticUnavailable`，不能因此声称不存在错误。记录应只含安全的 method/code/时间等，分享前仍检查私有上下文。

没有自动修复所有 home 迁移的命令。不要删除 owner、锁、SQLite 或回滚快照来让错误消失。要做版本切换，先结束任务、停止对应后台并备份自有数据，再按[安装指南](install.zh-CN.md)启动完整新分发。
