# Memory providers

English | [简体中文](memory.zh-CN.md)

One **memory** provider is selected and pinned to a session. The official `file@1.0.0` comes from `@agnes/base`, with its implementation in `@agnes/memory-file`. It uses only the public [MemoryProvider contract](../../packages/extension-api/src/memory.ts). Deployments without a memory provider retain their existing behavior.

A plugin lists `providers` in its `agnes.plugins` entry's `inject` and registers its implementation:

```ts
import { memoryKind, type MemoryProvider, type ProviderPluginContext } from '@agnes/extension-api'

export const enterpriseMemoryPlugin = {
  apply(ctx: ProviderPluginContext) {
    ctx.providers.register(memoryKind, enterpriseMemory)
  },
}
declare const enterpriseMemory: MemoryProvider
```

Implement `open({ home, workspaceRoot, sessionKey })`, returning a `MemorySession`. `snapshot(turn)` contributes the bounded index through ordinary request sections; repeated calls for one turn must return the same revision. Live off policy returns no contribution and denies subsequent agent reads/writes. `files(fallback, source, signal, approve)` wraps normal file tools: ordinary workspace paths delegate to fallback, while memory paths use scoped reads and validated atomic writes. Optional `revision(path)` labels snapshot-backed reads. Human `inspect/configure/readFile/editFile` methods are explicit administration, independent of agent off permission. `inspect` returns metadata, never file bodies. Keep `open` lightweight; optional `close()` releases lazily opened resources after session work drains or an administration operation finishes.

Use the profile's `providers.memory: { provider: enterprise, version: 1.0.0 }` to replace the default. A missing or invalid explicit selection fails closed; it must not fall back to the file provider. Installing multiple provider implementations differs from selecting multiple stores. Knowledge bases remain multiple independent MCP/tool/Skill/FDE capabilities and can coexist with the selected memory implementation.

The `approve` callback returns `MemoryApprovalResult`: `{ status: 'approved' }`, `{ status: 'rejected' }` for a real human refusal, or `{ status: 'unanswered', reason }` using the existing approval reasons. Ask mode requires an exact, once-only decision: a verified human answer under other presets, or the durable automatic decision under full access. Missing identity, agent answers and unoffered session/permanent choices are invalid. The file provider reports `MEMORY_APPROVAL_UNANSWERED` with the original reason; it never converts delivery loss into a rejection or a grant.

In Core-admitted file calls, the platform-owned approval callback stops a rejected or unanswered candidate before the provider can mutate it. Core verifies the proposal source against the current session, turn and tool call and binds a private refusal proof to that invocation. The tool returns `TOOL_REJECTED_BEFORE_EFFECT` with the memory diagnostic and `effect: "none"`, without reconciliation or parking. A copied or plugin-authored error does not carry that proof. The provider must await approval before any mutation and must let a callback failure abort the write. Approval admission, an earlier controlled effect or another concurrent write prevents a no-effect claim: CAS conflicts and failures after file commit remain unknown and are never automatically replayed. This preserves exact-content review and fresh proposals after unanswered attempts; it adds no durable memory continuation.

## Required behavior

- Default agent permission off; ask reviews an exact file-level proposal before any mutation. Bind approval to `baseHash`, `newHash`, full diff and session/turn. Full access automatically allows and records the exact proposal; broad grants under other presets cannot approve it. Reject/cancel/conflict never inject a candidate.
- Preserve a turn's index and topic revision across repeated model requests. Topic content is on demand in the model context. Human changes become visible next turn. Off takes effect on the next request even when that turn had an earlier snapshot.
- Keep storage caps independent of context allocation; budget both layers and headers. Use a visible omission marker. Reject over-cap consolidation without truncating the stored index.
- Compare exact revisions after approval, serialize writers, sync and atomically replace complete files. Preserve concurrent human edits. Commit a topic before its index link, and distinguish partial commits from no write.
- Scope normal tools to the session's own directory. The Host denies the official memory tree to raw filesystem/process operations and refuses unconfined execution, except under the explicit `full-access` permission without a usable OS boundary, where commands run unconfined and the official provider reports out-of-band file changes as a notice. An enterprise provider must protect its own backend equivalently; do not expose a write-capable remote port through shell or unauthenticated administration.
- Reject common credential-like content and document the detector's limits. Keep candidates, indices, topic text and echoed memory out of diagnostics/telemetry. Preserve only structural counts/sizes and writer identity. Do not reinterpret persisted memory as authorization.

The official **remembering** Skill is an official runtime registration through the public Skills service, guiding ordinary file tools rather than creating a separate memory-entry API. AGENTS.md and authoritative knowledge-base facts override learned preferences; session-query remains the conversation-history search. See the [user guide](../guide/memory.md) for limits, privacy and editor semantics, and [plugin registration](quickstart.md) for lifecycle contracts.
