# 知识来源

[English](knowledge-sources.md) | 简体中文

[插件生命周期](packages.zh-CN.md) · [凭据](credentials.zh-CN.md) · [记忆](memory.zh-CN.md)

当回答需要追溯具体文档版本时，可选用**知识来源**插件。知识与学习偏好分开；不自动扫描磁盘、创建向量索引、导出记忆、跨会话搜索或调用外部模型。

## 安装与配置

在**设置 → 插件 → 目录**选择**知识来源**（`@agnes/knowledge-sources`），检查能力后安装、信任并启用。保留离线来源为 `file:./bundled-plugins/knowledge-sources`。将插件行加入新会话 composition。仅安装不会启用包；旧会话缺少后端时，面板显示明确的不可用提示。

可信本地操作员通过现有 SDK 配置 profile managed resource。已有认证的 Node SDK `client` 时，调用：

```ts
const input = {
  sources: [
    {
      id: 'handbook', kind: 'local', path: 'docs/handbook.md',
      workspaceRoot: '/workspace/demo', sessionKeys: ['SESSION_KEY'], enabled: true,
    },
    {
      id: 'refunds', kind: 'synthetic-api', revision: 'r1',
      text: 'Refunds require a receipt.', available: true,
      workspaceRoot: '/workspace/demo', sessionKeys: ['SESSION_KEY'], enabled: true,
    },
  ],
}
const receipt = await client.extensions.callScoped({
  extension: 'plugin/a6558d7273477e08', service: 'knowledge.configure',
  operationId: 'configure-knowledge-1', input,
})
```

此包固定插件行的后端 owner 为示例中的 `plugin/a6558d7273477e08`，由 Host 绑定；不是用户或租户标识。填写实际 canonical 工作区根和后端会话 key。这是操作员维护的来源授权列表，模型参数不能选择 owner 或工作区。调用方需要现有机制授予的准确服务权限。在**审批**中核对原生决策，允许一次后使用同一 operation id 重提完成；不同配置使用新 operation id。未知结果不能直接重放。参见 [profile services](../develop/profile-services.zh-CN.md)。

默认空配置不授予任何来源。本地路径必须是无遍历的相对路径；读取经过 Host 的实时文件边界。拒绝符号链接、非普通文件、超过 64 KiB 的文档、无效 UTF-8 和常见凭据样式内容。synthetic API 为离线进程内 fixture：`available: false` 模拟上游失败；修改 revision 或 text 模拟新版本，不会访问真实服务。配置不接受原始 token、秘密值、任意 API 地址或写方法。生产连接器需另行审核 managed transport，并使用凭据引用。

## 检索与审核

1. 请 Agent 以 `{}` 调用 `knowledge_query`。仅列出授予当前 Host 绑定会话与工作区的来源。
2. 查询 `{ "sourceId": "refunds", "query": "receipt" }`。成功结果含 sourceId、revision、获取时间、定位信息、全文 SHA-256、有限摘录 SHA-256 和 untrusted 标记。无匹配时没有引用；读取失败明确拒绝，不捏造证据。
3. 打开右侧工作台**知识来源**，用**刷新权限与版本**核对当前状态。**读取原文版本**重新检查授权后，以纯文本展示当时的准确摘录。
4. 通过新审批将 r1 改为 r2，或修改本地文档；旧引用显示**来源已变更**。即使 API revision 未变，内容 hash 变化也会检测到，不会用新原文冒充旧摘录。
5. 停用来源、移除会话授权或删除配置项。刷新后显示**读取权限已撤销**；新的检索和预览均拒绝。停用/卸载包会撤销 managed resource 并释放注册；保存的旧会话不能复活资源。

面板在刷新和每次预览时检查，最后显示的状态不代表持续推送的授权保证。每会话保留最近 32 条引用元数据回执，资源重启/改配置后仍保留；会话账本另有插件自己的 citations projection。审查制品只含元数据与 hash，不保存文档副本。已交付的摘录仍属于获授权的会话历史；来源撤权阻止新的连接器读取与预览，不会追溯抹除会话。

检索内容均作为证据，包括要求 Agent 忽略指令的文字。连接器不把原文加入系统指令，也不自动执行其中内容。业务写入属于另一个独立审批工具。这些来源 ACL 不新增企业多租户隔离；profile 所有权、来源认证与会话 admission 继续由既有后端负责。
