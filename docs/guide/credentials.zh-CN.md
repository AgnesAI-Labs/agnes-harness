# 管理通用凭据

[English](credentials.md) | 简体中文

[文档](../README.zh-CN.md) · [MCP](mcp.zh-CN.md) · [安全](security.zh-CN.md)

本地管理员可以保存一次 API key 或 token，然后在 MCP、插件配置和 webhook 规则中使用其引用。后端、SDK 和 Web 凭据编辑器均已支持这条链路。

## 创建并使用凭据

使用已认证的本地管理员 SDK 连接。普通浏览器聊天连接没有这些管理权限。将服务提供的密钥作为 `suppliedKey` 传入，避免写入源码或日志：

```ts
const credential = await client.credentials.create({
  label: '业务服务',
  value: suppliedKey,
})
// 配置中只保存 credential.id，不保存 suppliedKey。
const secretBinding = {
  kind: 'http-bearer',
  credentialRef: credential.id,
}
```

daemon 生成不可变的 `secret://generic/<UUID>` id。MCP 的 `secretBinding.credentialRef` 或已有 `stdio-env` 绑定使用该 id；插件的 secret 字段与触发器的 `secretRef` 使用相同引用。改名不改变引用。轮换值在消费者下次解析引用时生效，已有连接可能需要重新连接。

## 在 Web 界面管理凭据

打开 **设置 → 权限 → 凭据**。列表显示名称、API 密钥类型、创建日期和使用它的配置。点击 **新建凭据**，输入名称和密钥值后保存。密钥输入默认隐藏，可以在输入时切换显示；保存成功后清空输入，已保存的值无法读取。

行菜单提供重命名、替换密钥值和删除。重命名不会改变引用；替换后 MCP 服务可能需要重新连接。删除前会显示使用方，被引用时后端拒绝删除。请先移除引用，或明确勾选确认这些配置将停止工作，再选择 **仍然删除**。

MCP 添加和编辑对话框的凭据选择器旁也有 **新建凭据**。保存后自动选中新凭据，并保留连接草稿。插件的密钥字段和触发器的凭据选择器也可选择通用凭据，同时保留既有引用。服务恢复只读、权限不足或凭据存储不可用时，页面或对话框会显示具体说明。

## 公开合同

| SDK 方法 | `_agnes/v1/admin.credentials.` 后的方法后缀 | 输入 | 返回 |
| --- | --- | --- | --- |
| `credentials.list()` | `list` | `{}` | `{ items: CredentialMetadata[] }` |
| `credentials.create(input)` | `create` | `{ label, value }` | `CredentialMetadata` |
| `credentials.set(input)` | `set` | `{ id, value }` | `CredentialMetadata` |
| `credentials.rename(input)` | `rename` | `{ id, label }` | `CredentialMetadata` |
| `credentials.delete(input)` | `delete` | `{ id, force?, confirm? }` | `{}` |

`CredentialMetadata` 仅含 `id`、`label`、`kind: "api-key"`、`createdAt`（UTC ISO 时间）与 `references`。每条引用为 `{ kind, profile, configId }`，kind 为 `mcp`、`plugin`、`trigger` 或 `profile`。列表管理通用命名空间；模型账户与 OAuth 凭据保留已有账户／登录接口。手工保存的 secret 和 provider 凭据继续沿用现有引用。

label 为 1–128 字符，value 为 1–65,536 字符，拒绝控制字符。value 只写，所有方法均不返回值、值摘要或请求体。拒绝未知字段，包括调用者传入的 actor。

读取要求 `credentials.read` 及已有 `packages.read` 本地管理员授权；修改要求 `credentials.write` 及 `packages.activate`。拒绝受限方法授权、非本地身份与普通聊天连接。Web 管理桥提供 `GET /admin/api/credentials` 与 `POST /admin/api/credentials/{create,set,rename,delete}`，使用同样的数据形状与来源检查，经启动器的私有本地 SDK 连接转发。控制面处于只读恢复模式时拒绝修改。

失败沿用标准 App Server 错误封套。固定 cause code 包括 `CONFIG_CREDENTIAL_REFERENCED`、`CONFIG_CREDENTIAL_CONFIRMATION_REQUIRED`、`CONFIG_CREDENTIAL_NOT_FOUND`、`CONFIG_CREDENTIAL_UNAVAILABLE`、`CONFIG_CREDENTIAL_READ_ONLY` 和 `CONFIG_CREDENTIAL_STORE`。权限拒绝为 `CAPABILITY_DENIED`，非法输入为 `INVALID_PARAMS`；错误详情不包含值。

## 轮换与删除

`set` 原子替换完整值，并发更新采用最后写入生效，没有 revision 或 CAS 参数。daemon 串行处理凭据操作，轮换时保留 label 与创建时间。更新失败时原值仍可使用，但底层持久化若在替换后报告不确定失败，调用者需重新检查状态。

已保存的 MCP 定义、触发器规则、profile 或插件配置仍引用 id 时拒绝删除。禁用配置、未完成 MCP 操作、插件已保存值及保留的回滚目标也计入引用。应先移除引用；若明确接受这些配置失效，按其他管理修改的显式确认模式同时传入 `force: true` 和 `confirm: true`。仅传 force 被拒绝。强制删除不修改引用配置，后续解析按关闭原则失败；引用检查失败时，即使已确认也拒绝删除。

## 存储与诊断

值由现有凭据库管理，在既有 home secrets 目录保存私有 API-key JSON 封套。POSIX 使用所有者检查、目录 `0700`、文件 `0600`、原子替换与 fsync；Windows 沿用 native 私有 ACL 实现，没有新增加密层。通用写入要求当前 file adapter 使用该规范目录；env、vault 或自定义路径会被拒绝，避免保存无法使用的凭据。

凭据审计记录操作尝试，仅含连接 actor、id、action，以及审计时间和事件类型，不含 label、value 或值摘要。响应和错误不包含值；诊断导出保持现有元数据白名单，不导出凭据库。不要将密钥粘贴到 label、配置字面值、会话提示或应用日志。

模型账户设置区分未配置、网络或目录获取失败、验证结果未知及服务端拒绝。只有携带凭据的请求收到 HTTP 401/403 才会提示 API Key 被拒绝；未填写密钥的中转站要求认证时显示“未配置”。网络检查失败不会删除已保存的凭据。
