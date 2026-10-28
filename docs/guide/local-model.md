# Use a local model

English | [简体中文](local-model.zh-CN.md)

[Documentation](../README.md) · [Headless and replay](headless.md) · [Configuration](../reference/configuration.md)

The optional `@agnes/model-adapters` package exposes `modelAdaptersPlugin`, which registers `local-openai`. Install and trust that package in your source runtime, or include its registration in your own plugin. Select `local-openai` in the profile's `providers.model-adapter.provider`; it is not selected by default. Inference uses the existing pi-ai OpenAI-compatible wire adapter, including its streaming, tool and multimodal translation.

Start your local server with a model already downloaded, then use its OpenAI-compatible endpoint:

| Server | Typical base URL |
| --- | --- |
| Ollama | `http://127.0.0.1:11434/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |
| vLLM | `http://127.0.0.1:8000/v1` |

These addresses are examples; use the address configured on your server. The adapter adds `/v1` when absent. It does not download models or contact an external inference service. Once the runtime, server and model files are installed, this configuration works offline. Server/model setup and quality depend on that installation; the adapters do not infer a model's capabilities from its name.

## Configure through Web

For a local server that supports OpenAI `/chat/completions`, you can also use **Settings → Models → Add account → OpenAI-compatible endpoint** without installing the optional adapter above. Enter the server URL, list or type its model IDs, test and save, then choose the model in a new conversation. Leave the API key empty only when the server accepts keyless requests: inference sends the placeholder bearer `no-key`; model listing sends no credential. These account models declare text input and native tool calls only. Set a context budget appropriate for your loaded model; a discovered ID alone does not prove its capacity. Use the profile route below when you need explicit capability metadata or the local adapter’s discovery/recording controls.

## Profile route

Add a route to the existing profile's provider configuration. Preserve its provider package and other routes as needed. The plugin package must also be present in the profile's package tree.

```yaml
packages:
  - id: "@agnes/model-adapters"
    source: "file:./model-adapters"
providers:
  model-adapter: { provider: local-openai }
provider:
  package: "@agnes/ai"
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
          thinkingReplay: drop
          contract_id: null
      models: []
```

`discover: true` reads `/v1/models` during adapter creation. Provide capacities and capabilities appropriate for the **loaded** models; discovery returns ids, not those guarantees. Automatic discovery requires explicit `keyless: true`. A keyless route cannot also name `credentialRef`. Without keyless opt-in, pi-ai refuses inference until a credential is bound. Authenticated discovery is available separately via the helper below; save reviewed model records into the route and bind credentials through the existing secret store. Never embed a key in `baseUrl` or `compat`.

To avoid discovery at startup, omit `discover` and supply full model records in `models` (id/name/api/route/baseUrl/reasoning/input/cost/contextWindow/maxTokens/toolCallFormats/thinkingReplay/contract_id). Use `api: openai-completions` in those model records; the route's `api: local-openai` selects the registry entry. This supports offline startup with a reviewed static catalog.

Choose a returned model id through the existing session model selector, for example `--model primary=local/qwen2.5:7b`. Select `input: [text, image]` only for a model/server that actually accepts images. Tool support depends on both the model and server's OpenAI-compatible implementation. `compat.wireCompat` can pass pi-ai wire compatibility options without changing the AGH configuration keys.

`toolCallFormats` says how a model's tool calls arrive. `native` means in the server's tool-call field; AGH then never turns call-shaped text in the answer into a call, and never reads a call out of reasoning on any route. A model that writes calls as text lists those formats instead or beside `native`, for example `toolCallFormats: [hermes_tool_call]` (`<tool_call>{...}</tool_call>`), `qwen3_coder` (`<function=...>`), `anthropic_invoke` or `inline_json`; calls are then read from the answer text in those formats only. A record that lists no text format gets no text recovery, and `[]` means the same. Discovered model ids containing `qwen` default to `[native, qwen3_coder]`, as the built-in catalog does, because Qwen models are known to write that syntax into their answer; a `toolCallFormats` in `modelDefaults` or a model record replaces that default. Models of an OpenAI-compatible endpoint saved in Settings declare `native` only.

## Explicit discovery and recording

```ts
import { discoverLocalModels } from '@agnes/model-adapters'
const ids = await discoverLocalModels({
  baseUrl: 'http://127.0.0.1:11434/v1',
  signal: controller.signal,
  // credential: valueFromYourSecretStore, // only when the server requires it
})
```

Discovery refuses redirects, userinfo/query/fragment in the URL, invalid/duplicate ids, more than 4096 models or a response over 1 MiB. It has a five-second deadline and sends no Authorization header for keyless servers. Failure does not fall back to a vendor catalog.

Add `compat.recordFile: /absolute/responses.jsonl` to record the local adapter's model replies for [replay](headless.md). The file must not exist. One adapter instance writes one file; use one route when the trace will be replayed. A model record's zero cost denotes local billing configuration, not missing token usage: runtime usage events still populate metrics.

Known Agnes image and video generation IDs are excluded from conversation model lists, including relay accounts. They cannot be saved as chat defaults or auxiliary chat models. If an older account selected one, choose a chat-capable model before starting a session or schedule. Image-input chat models remain available.
