# Integrate a channel with the AGH bridge

English | [简体中文](channel-bridge-integration.zh-CN.md)

[Author kit](README.md) · [Channel overview](channel-plugins.md) · [Architecture](../develop/channel-plugins.md)

This implementation guide targets new Feishu, WeCom, WeChat and other messaging adapters. It describes the current worktree's Extension API **5.7.0** and channel bridge, including lessons from the independent DingTalk adapter. It does not certify every platform, protocol or operating system. The recipient needs a Harness build containing the bridge, not just a matching version label.

## 1. Ownership and delivery

Ship an independent, reviewed plugin package per platform; represent multiple organizations or bots as instances. The plugin owns platform authentication, verified event normalization, media downloads, presentation, delivery/editing, disconnect and platform backoff. AGH owns trust review, credential resolution, managed lifecycle, session authorization and bindings, forwarding baselines, input deduplication, outbound receipts, persistence and the shared interface.

Do not copy a runner, discover another daemon, maintain another binding database or read a private credentials file. Do not create or choose arbitrary AGH sessions from the adapter. Normal channel onboarding requires no vendor-specific frontend or hardcoded frontend channel list.

```text
Platform → authenticated plugin event/download → toSession → authorized binding
         → native session and attachment admission → agent
Agent projection / new AGH user text → durable outbound queue → plugin send/update → platform
```

## 2. Verify the platform prerequisites

1. Choose a supported bot/application protocol. Verify actual message and conversation types and mention requirements; group and bot-DM capabilities may differ.
2. Confirm app publication, organization authorization, credentials, bot scopes, subscriptions and media-download permissions. Webhooks also require signature/replay validation and a declared deployment/listener design.
3. Start with text; enable images, documents, voice/video, threads, editing, cards and directories independently. Downloadable media does not establish model understanding.
4. Implement the actual platform payload and identity mapping. Do not copy DingTalk field names or API assumptions; do not assume an automatically available official WeChat bot protocol.

## 3. Layout and public dependencies

```text
channel-example/
  package.json
  src/index.ts
  src/adapter.ts
  src/gateway.ts
  src/events.ts
  src/channel-manifest.json
  assets/icon.png
  build.mjs
  scripts/write-manifest.mjs
  test/
  README.md
  LICENSE
  NOTICE
```

Use author SDK artifacts matching the recipient. For this source preview follow [quickstart](quickstart.md); do not assume a current published npm SDK. Development links must not become machine-specific runtime paths in the tarball.

Import channel contracts from `@agnes/plugin-runtime/channel-contract`, general author types and `managedServiceCapabilities` from `@agnes/plugin-runtime`, and message content from `@agnes/protocol`. Private Host or `@agnes/channels/src/...` imports are not an author API.

## 4. Start with an honest text-only manifest

`src/channel-manifest.json`:

```json
{"id": "example-chat", "displayName": "Example Chat", "version": "0.1.0", "connection": {"modes": ["stream"], "default": "stream"}, "capabilities": {"edit": false, "card": false, "thread": false, "attachment": false, "reactions": false, "typing": false, "voice": false}, "credentials": {"required": ["clientId", "clientSecret"], "optional": [], "exposes": []}, "limits": {"textChars": 12000, "cardBytes": 65536, "editWindowMs": 0, "rate": {"perChatPerMin": 20, "perAccountPerSec": 10}}, "events": {"supported": ["message"]}}
```

The npm package name, plugin row ID and provider/channel ID are different identities. Keep the channel type independent of bot account and instance IDs. `provider.id` must equal `manifest.id`. The schema rejects extra fields, requires the default connection mode to be declared, disallows overlapping required/optional credentials and requires card support for cardAction events. `credentials.exposes` allows identity raw fields, not secrets.

AGH freezes the registration manifest. The adapter must return the same contents, including artwork; effective capabilities can be reduced per instance but cannot exceed the declared ceiling. See the [wire schema](../../packages/protocol/schema/channel.json).

## 5. Register through the managed bridge

Implement the platform factory in `src/adapter.ts`; this is the entry point:

```ts
import type { PluginContextFacets } from '@agnes/plugin-runtime'
import type { ChannelConfiguration, ChannelProvider } from '@agnes/plugin-runtime/channel-contract'
import manifestJson from './channel-manifest.json' with { type: 'json' }
import { createExampleAdapter } from './adapter.js'

export const provider: ChannelProvider = {
  id: 'example-chat',
  version: '0.1.0',
  manifest: manifestJson as ChannelProvider['manifest'],
  configSchema: {
    type: 'object', additionalProperties: false,
    properties: { region: { type: 'string', title: '服务区域 / Region', enum: ['global', 'cn'] } },
  },
  create({ config }) {
    return createExampleAdapter({ manifest: this.manifest, config })
  },
}

export const main = {
  inject: ['profileRuntime', 'services', 'providers'],
  apply(ctx: Pick<PluginContextFacets, 'profileRuntime'>, config: Partial<ChannelConfiguration> = {}) {
    if (!ctx.profileRuntime.registerChannel) throw new Error('Channel bridge unavailable')
    ctx.profileRuntime.registerChannel(provider, { instances: config.instances ?? [] })
  },
}
```

Validate factory configuration, enum values and extra fields; configSchema is not an excuse to trust values. Keep sensitive credentials out of config. Do not silently select a different organization or region.

`registerChannel` registers both the catalog provider and managed resource. Do not also register the same provider manually; `providers.register` alone does not provide the complete lifecycle/binding flow. Start with `instances: []`, so installation does not automatically connect an account.

## 6. Generate the package declarations

Save as `scripts/write-manifest.mjs`, execute from the plugin root with the matching author SDK prepared, for example using tsx. This generates public service schemas rather than copying stale JSON. The SDK used for development is not bundled again for installation.

```js
import { readFile, writeFile } from 'node:fs/promises'
import { managedServiceCapabilities } from '@agnes/plugin-runtime'
import { CHANNEL_CONFIG_SCHEMA, channelServiceCapabilities } from '@agnes/plugin-runtime/channel-contract'

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
pkg.name = '@your-org/channel-example'
pkg.version = '0.1.0'
pkg.type = 'module'
pkg.engines = { node: '>=24.10' }
pkg.exports = './dist/index.mjs'
pkg.files = ['dist', 'assets', 'README.md', 'LICENSE', 'NOTICE']
pkg.agnes = {
  hostProvidedExternals: {
    '@agnes/plugin-runtime/channel-contract': '0.0.0',
    '@agnes/protocol': '0.0.0',
  },
  provides: ['service'],
  metadata: { displayName: 'Example Chat', summary: 'Independent Example Chat channel' },
  plugins: [{
    id: 'ext:your-org.channel-example', export: 'main', apiRange: '^5.7.0',
    runtime: 'in-process', default: true,
    inject: ['profileRuntime', 'services', 'providers'],
    configSchema: CHANNEL_CONFIG_SCHEMA, config: { instances: [] }, configReload: 'live',
    capabilities: {
      network: ['api.example.invalid', 'stream.example.invalid', 'media.example.invalid'],
      secrets: ['secret://example-chat/*'], store: true,
      managedServices: [{
        id: 'channel', scope: 'profile', artifact: { kind: 'in-process' },
        listeners: [], healthPath: '/health', startupTimeoutMs: 30000,
        shutdownTimeoutMs: 5000, apiVersion: '1.0.0', requires: [],
      }],
      services: [
        ...managedServiceCapabilities('channel', CHANNEL_CONFIG_SCHEMA),
        ...channelServiceCapabilities(),
      ],
    },
  }],
}
await writeFile('package.json', JSON.stringify(pkg, null, 2) + '\n')
```

Replace the `.invalid` API, stream and media hosts with actual reviewed host patterns. Network entries are hostnames/patterns, not full URLs. Secret grants must cover the namespace actually selected by the user; generic credentials need an explicit matching grant. Do not default to all network or all credentials.

The profile facade supplies channel.status/configuration/check/retry/reconcile/configure. The session facade supplies channel.session/bind/unbind. Declare both. Configuration retains native approval. Session binding's requiresApproval: never does not bypass session, workspace, identity, target or version checks.

The empty listeners example is for an outbound stream. healthPath is managed metadata, not an instruction to open another health server. Webhook implementations need reviewed listeners and lifecycle as described in [managed transports](transports.md); changing the manifest mode alone is insufficient.

Plugins execute with the user's rights. Capabilities are reviewed at admission, not a universal sandbox for arbitrary JavaScript. The plugin must still implement input, identity, URL and scope checks.

## 7. Implement every required adapter method

Each factory call returns an isolated adapter: no shared credentials, sockets, learned bot identity or targets across instances. The complete signatures are in the [public contract](../../packages/extension-api/src/channel-contract.ts).

- manifest and capabilities: immutable contract and effective instance features.
- connect(options): use backend-resolved credentials; subscribe with options.signal. Resolve when connected, not only when the stream finally ends.
- disconnect(): idempotently close sockets, subscriptions, downloads, queues and timers; obsolete callbacks must not affect a replacement connection.
- toSession(): return a normalized intent or null for non-business events. Do not drop attachment-only messages because text is empty.
- resolveScope(): platform scope and direct-message fact, not an authorization decision.
- credentialOf(): verified channel/account/user/chat identity, with kind: channel, channel, accountId, userId, chatId and chatType; keep raw minimal.
- render(): convert supported projection nodes to ChannelMessage, returning null otherwise. Do not mirror every user node yourself; the bridge owns user labels and echo suppression.
- send(): return a real MessageRef only after successful platform delivery.
- update(): use genuine editing when declared; otherwise refuse rather than silently posting duplicates.
- renderApproval/onApprovalAction: required methods even without interactive cards. Plain explanation and null actions are acceptable. A text “approve” must never authorize arbitrary native actions. Native approvals for current bindings remain in AGH.

attention, react, onSlotAction and syncDirectory are optional. Normally omit attention to retain the bridge's allowFrom/requireMention checks; a custom implementation must preserve equivalent checks.

## 8. Normalize events and routing

Call onEvent only after authenticated/verified platform intake. Validate stable event/message/account/user/chat IDs, timestamps, conversation types and mention facts. Display names are not authorization IDs. Preserve IDs across duplicate deliveries instead of generating fresh random values.

Text-only starting point, not an attachment implementation:

```ts
import type { ChannelAdapter, ChannelEvent, InboundIntent } from '@agnes/plugin-runtime/channel-contract'
import { sessionKeyFor } from '@agnes/plugin-runtime/channel-contract'

export function toSession(
  adapter: ChannelAdapter,
  event: ChannelEvent,
  context: { tenant: string; agent: string },
): InboundIntent | null {
  if (event.kind !== 'message' || !event.text.trim()) return null
  return {
    sessionKey: sessionKeyFor({ ...context, channel: adapter.manifest.id, chat: event.chat }),
    credential: adapter.credentialOf(event),
    eventId: event.eventId,
    messageId: event.messageId,
    content: [{ type: 'text', text: event.text }],
    kind: 'message',
  }
}
```

Use supplied tenant/agent and sessionKeyFor. Do not hardcode tenancy or discover another daemon. Empty or colon-containing key segments are refused; encode such vendor IDs deterministically without collisions, keeping original IDs for platform delivery. Threads require a threadId and an honest thread capability. Do not infer verified bot mentions from an arbitrary text prefix.

Vendor content can be an object or JSON string; rich text may contain arrays and media fields at different nesting levels. Parse with bounded lengths and verify against real callbacks rather than reporting a missing code because a string was read as an object.

## 9. Submit actual attachment content

The adapter verifies the event, resolves media identifiers/download codes, validates the temporary URL and downloads bounded bytes. toSession then submits content. Harness does not automatically resolve platform download codes or fetch arbitrary Attachment.url values.

```ts
import type { ContentBlock } from '@agnes/protocol'

// bytes must already be downloaded and bounded by the platform adapter.
export function fileContent(name: string, mimeType: string, bytes: Uint8Array): ContentBlock {
  return { type: 'file', name, mimeType, data: Buffer.from(bytes).toString('base64') }
}
export function pngContent(bytes: Uint8Array): ContentBlock {
  return { type: 'image', mimeType: 'image/png', data: Buffer.from(bytes).toString('base64') }
}
```

Place these blocks in intent.content beside text. pngContent is valid only for actual PNG bytes; use image/jpeg for JPEG. Other image formats, documents and audio/video may be saved as files. Sanitize names, remove paths/control characters, bound length and normalize MIME parameters. Do not pass an HTML error page as an image.

A synthetic attachment://hash or manually constructed artifact://hash is not evidence of storage or authorization. Do not write the artifact directory yourself or rely on an expiring URL as a permanent attachment. Native admission owns storage, receipt authorization, session ownership and subsequent reads.

Bound bytes per file/message, count, pixels and timeout. DingTalk currently downloads at most 20 MiB total and 50 attachments per message; these are adapter policies, not universal promises. Preserve successful files on partial failure and report only fixed categories/numeric statuses, never credentials, download codes, signed queries or raw response bodies.

Validate scheme, userinfo, host and all resolved DNS addresses. Reject loopback, private, link-local and reserved destinations; pin validated DNS answers to the connection. No unchecked redirects or platform tokens sent to a CDN. HTTP compatibility must upgrade to validated HTTPS with no plaintext download. Distinguish DNS failure from a non-public destination instead of disabling checks for proxy DNS.

The bridge may degrade a definitive native image data/MIME/pixel refusal to an ordinary file with a separate stable correlation and notice. Uncertainty, authorization, quota or storage failures do not trigger that retry. The notice does not mean vision processed the image. Current inline intake checks approximately 2.12 million pixels before resizing, so large screenshots may degrade; this is an implementation limit, not a platform specification. Model declarations and media support still matter.

## 10. Outbound delivery and echo prevention

Only post-binding messages are forwarded. Platform input is suppressed on outbound; AGH user text is labeled as an AGH user message and assistant replies share the queue. AGH user attachments currently produce an “open in AGH” notice, not an automatic upload to every platform.

Use ChatTarget.deliveryKey for platform idempotency where available. MessageRef must identify an actual delivered message, including cardBizId where needed. Do not retry an uncertain send blindly or invent a success receipt. Handle formatting, text limits, splitting, rate limits and editing windows explicitly. Verify card actor, request identity and expiry; historic cards must not decide unrelated current approvals.

## 11. User configuration and binding flow

1. Install, review, trust and enable. The provider appears dynamically in overview and session picker.
2. Create a real session; send the first message for a draft. Open Channels beside the composer.
3. Backend derives instance ID, workspace and agent. The plugin requests credentials and non-sensitive platform parameters only.
4. Saved secret references are resolved by the backend under reviewed grants. Namespace grants must match the references users actually selected.
5. Save through native approval; message the bot, with a mention when required, to confirm a target.
6. Refresh and explicitly confirm/bind the target. Workspace must match and no pre-binding history is exported.
7. Bound composer controls show channel status and open the existing connection editor. The grouped overview shows instances, session titles and targets, with unbind/move actions.

Configured, connected and bound are different states. Reconnect requires a fresh trusted target message. Unknown transitions need native recovery/unbind, not plugin-owned routing changes. Successful uninstall clears this plugin's current-profile channel overrides, targets and bindings; credentials and conversation history remain. Disable, restart and update preserve configuration. Other profiles/namespaces and remote app state are not automatically deleted.

## 12. Artwork and shared UI

manifest.icon is an optional PNG/JPEG base64 data URL generated from packaged artwork, never a remote URL. Maximum complete length is 32768 characters, decoded bytes 24 KiB and total pixels 1048576; prefer square artwork no larger than 512×512. Missing/invalid/failed images use the default channel icon. Provider and adapter must use identical generated manifests. Record provenance and brand rights separately from the code license.

Catalog, credentials, configSchema and native binding state drive the shared interface. Use meaningful titles/descriptions, conditional requirements where appropriate and no tokens or unnecessary implementation fields in user flows.

## 13. Lifecycle, isolation and operating systems

Changing authentication must clear token caches, learned bot identity and old targets. Use connection epochs so old callbacks cannot mutate current state. Stop intake before draining/closing, and report uncertain shutdown through managed recovery. Test sleep/wake, backoff and limits; Webhooks need signature/time and replay handling. Do not persist download codes or signed links in logs.

Use Node path/URL APIs without drive literals. Pure JS tarballs are typically portable; native dependencies require matching target artifacts. The Harness runtime itself is platform-specific: a Windows local build cannot be copied to Mac. This work has Windows verification; macOS needs separate acceptance.

## 14. Build and distribution

Minimal ESM build.mjs:

```js
import { build } from 'esbuild'
await build({
  entryPoints: ['src/index.ts'], outfile: 'dist/index.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
  external: ['@agnes/plugin-runtime/channel-contract', '@agnes/protocol'],
})
```

This is a starting point. Dynamic CommonJS dependencies may require createRequire compatibility or preserved module boundaries. Explicitly copy JSON/assets loaded at runtime; static JSON imports may be inlined. Keep the public channel contract and protocol external with matching hostProvidedExternals. Additional runtime SDK imports need their own correct external/mapping; never bundle another kind token or a generic runner.

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm pack
```

Define these scripts and lock development dependencies. Run them in the independent plugin. Repository work uses its pinned mise exec -- node tools/toolchain/run.mjs entry and records actual Node version.

Inspect the tarball: dist, required assets and licenses belong inside; node_modules, backups, SDK links, machine paths, secrets, instance configuration and conversations do not. Recipients install the local tgz through plugin source review, enable and supply their own credentials. New capabilities need review. Portable plugins do not make the host runtime cross-platform.

## 15. Acceptance gates

1. Schema/identity/capability ceilings and both service facades; refusal for missing grants or mismatched manifests.
2. Independent enterprise instances; credential replacement, startup cancellation, disable/uninstall and stale callbacks.
3. DM, group mention/no mention, unauthorized sender, threads, duplicate IDs, malformed payload and object/string content.
4. Real image/document/audio/video and mixed text/media; exact original-byte reads after native storage; forged reference rejection; missing/expired codes, permissions, limits, DNS/private destinations and partial success.
5. AGH and assistant text sync without ingress echo; durable receipts and restart recovery without fabricated success or uncontrolled retries.
6. Native configuration approval, target confirmation, baselines, workspace refusal, unbind/move/reconnect and empty reinstall.
7. Two providers with multiple instances; dynamic discovery, correct titles/status/editor, custom/default icons, narrow layout and dark theme.
8. Live platform publication, scopes, organization access, actual CDN, sleep/wake and limits. Fake gateways and a successful public HTTPS file download cannot certify authenticated platform media delivery.

## 16. Troubleshooting

- Missing channel: trust/enabled state, assembled bridge, registerChannel, injections and reviewed managed/schema declarations.
- Configuration without binding: missing session service grants, a draft session, activation or workspace authorization.
- Connected without targets: actual verified callback, stable identity, allowFrom/mentions and non-null toSession.
- Text works but attachments fail: inspect payload shape/string parsing → media code → permissions → URL/DNS → bytes → content blocks → native admission → UI. attachment: true alone is insufficient.
- Image fallback notice: saved original, refused vision intake; inspect reason, pixels, format and model declaration. This differs from download failure and from an assistant repeating stale context.
- HTTP 400/403: identify token acquisition, link acquisition or file download stage before changing credentials/scopes. Never display raw backend bodies.
- DNS_FAILED/NON_PUBLIC_ADDRESS: distinguish resolution failure from private/reserved answers, including proxy DNS; do not disable destination checks.
- Downloaded but unreadable: verify actual file/image input and native storage, not only a URI/hash.
- Mac failure: verify macOS host build, API/bridge, native dependencies and instance paths. A win32 build-info entry alone does not make a JS plugin Windows-only.

## 17. Source index

- [Author/provider contract](../../packages/extension-api/src/channel.ts), [adapter contract](../../packages/extension-api/src/channel-contract.ts), [managed facade declarations](../../packages/extension-api/src/profile-runtime.ts).
- [Schema](../../packages/protocol/schema/channel.json), [bridge assembly](../../packages/channels/src/bridge.ts), [inbound](../../packages/channels/src/runner/inbound.ts).
- [Attachment admission](../../packages/core/src/request/attachment-admission.ts), [original reads](../../packages/core/src/request/session-files.ts).
- [Bridge tests](../../packages/channels/test/bridge.test.ts), [inbound tests](../../packages/channels/test/inbound.test.ts), [native original persistence tests](../../packages/core/test/attachment-admission.test.ts).

The examples are an authoring starting point. Authors still implement the actual gateway, verification, media conversion and delivery. Keep new platform protocols in independent plugins rather than moving them back into the foundation.
