# Windows 渠道运行说明

本说明对应源码工作区入口，适用于 PowerShell 5.1 和 7。渠道独立安装包、Windows Service 和真实钉钉服务验收仍未完成；不要把后台连接测试通过理解为这些功能已验收。

## 配置后台连接

先按工程启动说明构建并启动共享后台，再复制同目录的 `dingtalk.windows.example.yaml` 为自己的配置。修改 home、workspace、tenant、agent 和 credentialsFile；密钥文件应事先通过受信任的部署方式设置为运行账户可读的私有 Windows 权限，普通新建文件不保证满足权限检查。

`localDaemon.home` 和 `localDaemon.profile` 必须与运行中的后台一致。后台显式指定其他数据目录时，增加 `localDaemon.dataDir`。不要根据 tenant 或 agent 猜 profile；渠道不会替你启动后台。

默认数据目录为所选 home 下的 data。可用以下 PowerShell 命令查看连接值；自定义 dataDir 时相应修改发现记录路径：

```powershell
$daemonHome = 'D:\Agnes\home'
$discoveryPath = Join-Path $daemonHome 'data\daemon\discovery.json'
$discovery = Get-Content -LiteralPath $discoveryPath -Raw -Encoding UTF8 | ConvertFrom-Json
'unix:' + $discovery.socketPath
```

将输出原样填入 YAML 的 connect，使用单引号保留反斜线。这里读取文件只是帮助填写地址；实际连接仍由程序检查私有发现记录、后台存活身份和同一管道连接的服务端身份。不要修改 owner.json 或 discovery.json，也不要复制旧记录冒充当前后台。

## 从源码工作区启动

在仓库根目录运行，替换配置文件绝对路径。使用 pnpm.cmd，避免依赖 PowerShell 的 pnpm.ps1 执行策略；不需要改变全局执行策略。

```powershell
pnpm.cmd exec tsx .\packages\channels\src\bin.ts dingtalk --config 'D:\Agnes\channel.yaml' --verify
```

`--verify` 只校验配置、渠道描述和私有密钥文件，不连接后台，也不证明钉钉凭据有效。准备好实际接收消息后，去掉 `--verify` 启动渠道：

```powershell
pnpm.cmd exec tsx .\packages\channels\src\bin.ts dingtalk --config 'D:\Agnes\channel.yaml'
```

普通启动会连接后台和钉钉，按 allowFrom/requireMention 处理消息。状态默认保存在配置文件同级 state 目录，可通过 `$env:AGNES_CHANNEL_STATE_DIR` 显式选择其他位置。不要让多个渠道实例同时使用同一份状态。

`--verify-live` 属于另一条钉钉服务验证流程，会等待群消息，指定 chat 时还会发送卡片；它不验证 Agnes 后台连接，不应当成无副作用的本地检查。

## 连接与退出行为

- 后台异常断线：SDK 重试时重新读取所选 scope 的发现记录，不沿用旧 PID；真实后台换代后的初始化和会话查询已经验证。
- 已打开的会话在异常重启后可能需要等待旧写入租约到期，再由SDK重试恢复；当前默认租约为30秒，另外还有重试等待时间。已验证完成一轮消息的同一会话在租约到期后继续对话并保留历史；不要删除租约来加快恢复。
- 后台正常停止：SDK 收到 shutting_down 通知后停止自动重连，保留既有行为。后台重新启动后，需要重新启动渠道进程。
- 修改 home/profile/dataDir 或后台管道地址后，更新配置并重新启动渠道。
- Ctrl+C 使用现有渠道收尾流程。systemd 示例仅适用于 Linux，不能直接用于 Windows。

无法验证后台时，先检查后台是否运行、scope 是否一致、connect 是否与当前 socketPath 一致以及账户能否读取私有记录；不要通过放宽密钥或后台目录权限绕过检查。

源码渠道客户端与本地后台包的连接、错误进程拒绝、已完成一轮消息的会话在异常换代后继续对话已有测试证据；正在执行的请求、完整渠道消息路由恢复、真实钉钉收发、跨用户权限和安装分发仍需分别验收。检查入口见 `packages/channels/test/`；完整支持范围见[已知限制](../../../docs/reference/limitations.md)。
