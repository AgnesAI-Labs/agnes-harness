# 使用本地模型

[English](local-model.md) | 简体中文

[文档](../README.zh-CN.md) · [无界面运行与回放](headless.zh-CN.md) · [配置](../reference/configuration.zh-CN.md)

可选包 `@agnes/model-adapters` 导出 modelAdaptersPlugin，注册 local-openai。在源码 runtime 中安装、信任该包，或将其注册入口纳入自己的插件。provider.adapters 选择 local-openai，默认不会选中。推理复用现有 pi-ai OpenAI-compatible wire adapter，包含流式输出、工具和多模态转换。

提前下载模型，启动本地服务，再使用其 OpenAI-compatible endpoint：

| Server | 常见 base URL |
| --- | --- |
| Ollama | `http://127.0.0.1:11434/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |
| vLLM | `http://127.0.0.1:8000/v1` |

地址仅为示例，以服务实际配置为准。adapter 在缺少 /v1 时补上，不下载模型、不联系外部推理服务。runtime、服务和模型文件安装完成后，该配置可离线运行。服务安装与模型质量取决于具体环境；adapter 不根据模型名称推断能力。

## Profile route

在现有 profile 的 provider 配置中添加路由，按需保留 provider package 和其他路由。插件包也必须在 profile 的 package tree 中。

```yaml
provider:
  package: "@agnes/ai"
  adapters: [local-openai]
  catalog: { include: [] }
  routes:
    - route: local
      api: local-openai
      baseUrl: http://127.0.0.1:11434/v1
      compat:
        keyless: true
        discover: true
        modelDefaults:
          contextWindow: 32768
          maxTokens: 4096
          reasoning: false
          input: [text]
          toolCallFormats: [native]
          thinkingReplay: drop
          contract_id: null
      models: []
```

discover: true 在创建 adapter 时读取 /v1/models。容量和能力声明应适用于实际加载的模型；发现接口仅返回 ID，不提供这些保证。自动发现要求显式 keyless: true，且不能同时指定 credentialRef。不选择 keyless 时，pi-ai 会拒绝未绑定凭证的推理。需鉴权的发现操作可使用下面的 helper，再把已审核的完整 model record 保存到路由，通过现有 secret store 绑定凭证。不要将 key 写入 baseUrl 或 compat。

若不希望启动时发现模型，省略 discover，并在 models 中提供完整记录（id/name/api/route/baseUrl/reasoning/input/cost/contextWindow/maxTokens/toolCallFormats/thinkingReplay/contract_id）。model record 使用 api: openai-completions；route 使用 api: local-openai 选择 registry entry。这样可使用已审核的静态目录离线启动。

通过现有会话模型选择器选返回的 ID，例如 `--model primary=local/qwen2.5:7b`。只有模型和服务确实支持图片时才选 input: [text, image]。工具支持同时取决于模型和服务的 OpenAI-compatible 实现。compat.wireCompat 可传入 pi-ai wire compatibility 选项，与 AGH 配置键分开。

## 显式发现与录制

```ts
import { discoverLocalModels } from '@agnes/model-adapters'
const ids = await discoverLocalModels({
  baseUrl: 'http://127.0.0.1:11434/v1',
  signal: controller.signal,
  // credential: valueFromYourSecretStore, // 仅用于需要鉴权的服务
})
```

发现会拒绝 redirect、URL 中的 userinfo/query/fragment、无效/重复 ID、超过 4096 个模型或 1 MiB 的响应。超时为五秒；keyless 服务不发送 Authorization header。失败不回退到厂商目录。

添加 `compat.recordFile: /absolute/responses.jsonl` 可录制模型回复，供[回放](headless.zh-CN.md)使用。文件必须不存在。一份 adapter 实例写一个文件；用于回放时使用单一路由。model record 的零 cost 代表本地计费配置，不表示缺少 token usage；runtime usage 事件仍会填入指标。
