# 可观测性与问题诊断

[English](observability.md) | 简体中文

AGH 在 `@agnes/base` 中提供官方 `observability:otel` 插件，由 `@agnes/observability` 基于公共 `observabilityKind` provider 合约实现。**默认关闭导出**；仅设置 collector 地址不会开启。Core 不依赖导出器。

## 开启 OTLP 导出

管理员可在 `AGH_HOME`（通常为 `~/.agh`）创建 `observability.json`：

```json
{
  "enabled": true,
  "endpoint": "http://127.0.0.1:4318",
  "includeContent": false,
  "batchMs": 1000,
  "timeoutMs": 3000
}
```

修改文件或环境变量后重启 daemon。管理员负责 collector 目的地及访问策略；包含 collector 请求头的配置应保持私有。等价环境配置：

```sh
export AGH_OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
node agnes.mjs serve
```

支持以下设置：

| 环境变量 | JSON 字段 | 含义 |
| --- | --- | --- |
| `AGH_OTEL_ENABLED` | `enabled` | 显式开启，支持 `true`/`false` 或 `1`/`0` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `endpoint` | HTTP(S) 基地址，追加 `/v1/traces`、`/v1/metrics` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `tracesEndpoint` | 完整 trace 地址 |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | `metricsEndpoint` | 完整 metric 地址 |
| `OTEL_EXPORTER_OTLP_HEADERS` | `headers` | 逗号分隔的 `name=百分号编码的值`；JSON 使用对象 |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | `timeoutMs` | 请求与关闭期限，10–30000 毫秒 |
| — | `batchMs` | 批量发送间隔，10–30000 毫秒 |
| `AGH_OTEL_INCLUDE_CONTENT` | `includeContent` | 显式开启高风险内容导出 |
| `OTEL_SDK_DISABLED` | — | `true`/`1` 强制关闭导出 |

环境覆盖文件，显式普通插件配置覆盖两者。拒绝重定向、URL 内凭据及无效的已开启配置。实现发送 [OTLP/HTTP JSON](https://opentelemetry.io/docs/specs/otlp/) traces 和 metrics，不安装全局 instrumentation，也不提供 gRPC/protobuf 导出器。信号地址遵循 [OTLP exporter 规范](https://opentelemetry.io/docs/specs/otel/protocol/exporter/)。

## 导出的数据

公共 session 已提交事件产生 session、turn、model 和 tool span；公共 child 生命周期 hooks 将 child 及其 session/turn/model spans 接入父 trace。Supervisor seam 产生 daemon、worker 生命周期 span。不同进程使用独立生命周期 trace；暂未在 IPC 传播跨进程 trace context。

`agh.turn.duration`、`agh.tool.duration` 是毫秒 histogram；`agh.tokens.input`、`agh.tokens.output`、`agh.tool.calls`、`agh.tool.errors`、`agh.worker.restarts` 是 delta counter；`agh.queue.depth` 是已接纳命令数的 gauge，包含执行中的命令。工具错误率用 errors/calls 计算。已有结构化执行日志和审计记录在会话运行期间附带 `traceId`、`spanId`，日志正文不会上传。

默认属性只有哈希后的 session/model/tool/call 身份、turn 编号、时间、数量和成功/失败状态。排除提示词、回复、工具结果、文件正文、原始 session ID、工作目录路径及 collector 凭据。哈希用于关联；可猜测名称的哈希不构成匿名性保证。

**内容导出有风险。** `includeContent: true` 或 `AGH_OTEL_INCLUDE_CONTENT=true` 会加入最多 4096 字符的 user/assistant/tool 内容属性。凭据字段名及已识别的凭据字符串会被遮蔽，但自由文本仍可能包含个人信息或机密文件。只在工作负载及 collector 已获授权时开启。诊断导出始终排除内容，不受这个开关影响。

队列限制为 1024 条或 1 MiB，最多一个在途批次；collector 响应限制为 64 KiB。队列满时丢弃遥测；网络失败及可重试 HTTP 响应最多尝试三次。collector 拒收或部分接收不会造成执行失败。关闭在配置期限内 flush 并取消剩余请求。观测上限为 512 个 session、512 个 child、每个 session 同时 256 个工具。遥测尽力交付，不是审计账本；通过 collector 健康状态判断数据缺失。

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
