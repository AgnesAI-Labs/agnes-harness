# 可观测性与问题诊断

[English](observability.md) | 简体中文

AGH 在 `@agnes/base` 中提供官方 `observability:otel` 插件，由 `@agnes/observability` 基于公共 `observabilityKind` provider 合约实现。**默认关闭导出**；仅设置 collector 地址不会开启。Core 不依赖导出器。

## 开启 OTLP 导出

创建私有配置 `AGH_HOME/observability.json`（通常为 `~/.agh/observability.json`）：

```json
{
  "enabled": true,
  "endpoint": "http://127.0.0.1:4318",
  "redaction": "metadata",
  "headers": { "authorization": { "secretRef": "env:AGH_COLLECTOR_AUTH" } },
  "batchSize": 256,
  "batchMs": 1000,
  "queueSize": 1024,
  "timeoutMs": 3000,
  "shutdownPolicy": "flush"
}
```

官方插件在一秒内读取经过验证的配置变化。请求头只接受 `env:NAME` secret ref；值放入服务进程环境，禁止明文写入配置。找不到 secret 时安全退避。端点为 HTTP(S)，禁止用户名、密码、query 或 fragment。可选 tracesEndpoint / metricsEndpoint / logsEndpoint 是完整 signal URL；endpoint 为自动追加 /v1/traces、/v1/metrics、/v1/logs 的基础 URL。不会读取明文 OTLP 请求头环境配置。OTEL_SDK_DISABLED=true 强制关闭。

batchMs 和 timeoutMs 为 10–30000 毫秒，queueSize 为 1–16384 条，batchSize 为 1–queueSize。队列另有包含在途记录的 1 MiB 上限。shutdownPolicy 为 flush（默认）或 discard，timeoutMs 限定最终排空时间。溢出、永久拒绝和部分拒绝增加 drop 计数；可重试故障保留记录并指数退避。Agent turn 不等待 collector。

## 导出的数据

提交后的公开事件产生 session → turn → step → model/tool spans，每个 ledger 事件另有相关联的 OTLP logs（类型、序号、时间）。Resource 包含 service/version、哈希 workspace/session/pin 和 Host 提供的 generation ID；保留子代理和 daemon/worker 生命周期 spans，以及 duration/token/tool/queue metrics。通过公开 observabilityKind 可替换导出器；bindSession(key, resource) 接收身份和私有根，可选 health() 查询发送健康。Core 不执行网络导出。

默认 metadata 只传元数据。content 显式开启有界用户、助手、工具内容。凭据字段、已知 secret 格式、引用的 header 值以及涉及私有状态根的内容被删除或脱敏。启用 memory 的会话只传结构事件；导出器不读取私有文件。内容仍可能含业务机密，开启前需授权目标端点。

同进程同 home 的代际租约共享 session 序号水位、活动 spans 和发送队列。重叠的代际切换保留在途请求，不重放已接纳事件。排队记录沿用捕获时的端点与隐私策略，关闭只停止新的捕获；最后租约释放时排空。此机制为尽力遥测：进程崩溃丢失内存队列，网络回执不明确时重试可能导致 collector 重复。不能代替持久 ledger，不实现 feedback 授权前缀上传。不同 OS 进程使用独立管线。

## 导出支持包

```sh
node agnes.mjs diagnostics export --out diagnostics.json
node agnes.mjs diagnostics export --session SESSION_ID --out diagnostics.json
```

需要通过本地 owner 连接访问 daemon；指定 session 时再次检查 owner 的会话权限。CLI 在本地以私有权限原子写入文件，输出路径不会传到服务器。

有版本的包包含 AGH/Node/平台版本、可用的 profile/composition hash、generation 状态与计数、安全 doctor 状态、近期错误 ID、最后 100 条允许的审计元数据。指定会话只额外加入其哈希、最后序号和哈希后的 loop/generation pin。不包含对话账本、文件正文、凭据、异常消息、堆栈或原始 audit detail。worker 不可用时明确显示，导出不会启动 worker。

App Server 方法 `_agnes/v1/diagnostics.export` 支持可选 `sessionId`、`limit`（1–500 条审计记录）、`diagnosticId`。边界规范化的错误进入 4096 条进程缓冲；CLI 和生产 daemon owner 在 `AGH_HOME/diagnostics/errors.jsonl` 持久化安全错误元数据，并回放启动前错误。导出合并 journal 与进程缓冲；按 `diagnosticId` 精确查询过滤保留的进程缓冲及有界近期日志，不扫描完整持久历史。不会持久化异常正文。独立 SDK 嵌入若需要其进程自产错误跨重启查询，应通过公共 `observeDiagnostics` 合约安装持久 sink。sink 失败会标记 `diagnosticUnavailable`。

进程缓冲最多保留 4096 条错误。日志读取的条目上限限于 1–1000，最多扫描最近 `limit × 4096` 字节；精确 ID 查询使用 limit 1。因此重启后旧 ID 可能不可用，即使日志行仍存在。审计文件另有末尾 1 MiB 读取上限。删除 home 或日志会丢失历史。公开提交前仍需审阅脱敏包：时间、版本、摘要、平台与运行计数可能暴露部署元数据。

相关接口见[排障](troubleshooting.zh-CN.md)、[CLI 参考](../reference/cli.zh-CN.md)、[App Server](../reference/app-server.zh-CN.md)。

## Web 诊断

打开 **设置 → 诊断** 可查看近期安全错误记录、复制诊断 ID，或输入完整 ID 查询历史记录。**导出诊断包** 会下载脱敏 JSON；查询后仅选择该错误。页面还显示 Worker 状态、插件代数和绑定会话数，技术详情默认折叠。

遥测状态只读，反映 daemon 启动时的配置。收集端只显示主机名与端口，不显示 URL 路径、查询参数、请求头或凭据。启用内容导出时显示风险提示，但诊断包始终不含内容。修改 `AGH_HOME/observability.json` 并重启 daemon 后配置生效。后端注册自检方法时，页面还会提供 **运行自检**。
