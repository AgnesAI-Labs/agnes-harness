# Webhook 触发会话

[English](webhooks.md) | 简体中文

[文档](../README.zh-CN.md) · [Web 设置](web.zh-CN.md) · [部署](deployment.zh-CN.md)

业务事件可以驱动业务 Agent。打开 **设置 → 自动化 → 触发器**，创建规则，选择已登记的工作区、Agent 预设、Bundle 和 `secret://namespace/name` 密钥引用。表单只接收引用，不接收密钥值。通过已配置的密钥适配器预置密钥；文件密钥必须仅所有者可读。环境引用可以手动输入，例如环境适配器将 `secret://webhooks/github` 解析为 `AGNES_SECRET_WEBHOOKS_GITHUB`。

端点**默认关闭**。保存显式路径（如 `/hooks/events`）、载荷字节上限（默认 256 KiB，最高 1 MiB），再启用端点。`serve` 管理 HTTP 监听器并向共享 daemon 转发，请保持两者运行。规则与投递回执持久保存在 daemon 数据目录。

## 规则与提示

规则匹配提供者事件类型和全部字段条件，按规则 id 升序选择首个匹配规则。字段路径支持 `$.issue.title`、`$.repository.full_name` 和 `$.commits[0].message` 等数组索引，不支持表达式求值、通配符与递归遍历。字段条件使用精确 JSON 相等比较。

公开 `@agnes/extension-api` 合同导出 `WebhookTriggerProvider` 和 `webhookTriggerKind`（`webhook-trigger`，进程作用域）。官方 GitHub 和通用实现验证原始字节，只通过密钥引用解析凭据；规则与会话接纳仍归 daemon 管理。本地 `_agnes/v1/admin.triggers` 方法管理规则、端点设置和示例投递，浏览器通过同源 `/api/triggers` 适配器访问。

过滤条件示例：`{"$.action":"opened","$.repository.full_name":"example/business"}`。模板示例：`检查这个问题：{{$.issue.title}}`。每个所选值经过 JSON 编码，放在动态长度的 `UNTRUSTED` Markdown 围栏内。外部载荷不会改变权限。展开后的提示上限为 64 KiB。

每个成功投递通过普通会话流程创建根会话，使用选定工作区、预设和 Bundle。持久 key 以 `agnes:webhook:RULE_ID:` 开头，提示中标明触发来源。工作区归属、插件信任、工具策略和审批仍走正常链路，触发器不授予额外权限。最近投递显示状态与会话链接。测试按钮在后台签名示例并经过生产验签路径；成功测试会创建真实会话。

## 认证与重放

**GitHub：**设置 JSON 载荷和共享密钥。AGH 对原始 body 做 HMAC SHA-256，验证 `X-Hub-Signature-256`；`X-GitHub-Event` 提供事件类型，`X-GitHub-Delivery` 提供投递 id。GitHub **不签署时间戳请求头**，因此必须配置签名载荷里的时间字段，例如 `$.issue.updated_at`、`$.pull_request.updated_at` 或 `$.head_commit.timestamp`。没有合适时间戳的事件（包括普通 ping）会被重放窗口拒绝；可通过可信入口封装后使用 generic 提供者。旧事件的再次投递超过窗口时同样拒绝。

**Generic HMAC：**发送 `X-Webhook-Id`、`X-Webhook-Event`、`X-Webhook-Timestamp`（Unix 秒）和 `X-Webhook-Signature: sha256=HEX`。签名输入是 UTF-8 前缀 `TIMESTAMP\nDELIVERY_ID\nEVENT\n` 加上原始 JSON body，时间戳、id、事件类型一起认证。重复安全请求头会被拒绝。

**Generic bearer：**发送 `Authorization: Bearer TOKEN`、`X-Webhook-Id`、`X-Webhook-Event`，并在认证后的载荷中选择时间戳字段（ISO 日期字符串或 Unix 秒）。代理入口必须使用 HTTPS。两种 generic 方式都仅通过规则的密钥引用解析认证材料。

规则窗口同等限制过去与未来的时钟偏差，默认 300 秒、最高一天。投递 id 去重至少保留一天，且覆盖完整认证重放窗口；GitHub 还对签名 body 摘要去重，防止修改未被签名覆盖的 delivery id 绕过保护。去重最多 10,000 条，容量耗尽时拒绝新投递，不提前淘汰有效记录。每条规则按滑动一分钟限制接纳数，重启后仍有效。最新 200 条回执只记录状态、规则与会话标识，不保存载荷、签名或凭据值。

GitHub 的事件请求头同样不在签名范围内。请匹配签名载荷中的仓库身份和事件特有字段，并为独立来源配置不同密钥引用。最多保留 128 条规则及 64 个待处理的管理/投递请求；超过等待容量的投递返回 `capacity`。禁用规则或端点会停止新的接纳。

会话创建前持久化接纳预留。崩溃后可能留下 `unknown`；失败或未知投递不会自动重试，手动提交新事件前请检查对应会话。这不承诺外部业务效果严格只发生一次。

## 隧道或反向代理

保持 Web 监听器绑定本机回环地址。只公开**精确的已启用 webhook 路径**，不要公开 `/`、`/api/*`、`/admin/*` 或 daemon WebSocket。入口终止 TLS，设置匹配的请求大小限制与连接超时，保留原始 body 和认证请求头。上游 Host 设置为 `127.0.0.1:4177`（或配置的本地 Web 端口）。

专用 webhook 域名的 nginx 示例：

```nginx
location = /hooks/events {
    client_max_body_size 256k;
    proxy_set_header Host 127.0.0.1:4177;
    proxy_pass http://127.0.0.1:4177;
}
location / { return 404; }
```

隧道同样使用精确路径入口白名单，拒绝其余路径。路径保密不能替代认证，必须保留签名或 bearer 验证。禁用端点阻止新投递，不取消已创建的会话。
