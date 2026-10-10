# Feedback services

English | [简体中文](feedback.zh-CN.md)

Feedback is a workspace-scoped, request-instanced, single-selected profile provider (`agh.feedback`) installed by the daemon. `@agnes/host` exports `feedbackKind`, `FEEDBACK_DESCRIPTOR`, `createFeedbackOwner`, `createFeedbackService` and `FeedbackAuthority`. Wire DTOs `FeedbackRequest`, `FeedbackResult`, `FeedbackItem`, `FeedbackTarget` and `FeedbackGrowth` come from `@agnes/protocol` and `@agnes/protocol/gen/app-server`. The reserved facts stay `x/feedback/item` and `x/feedback/growth`.

```ts
interface FeedbackInstance {
  execute(input: FeedbackRequest, actor: Actor, signal: AbortSignal): Promise<FeedbackResult>
}
```

The daemon admits each request through the shared service binding. The installed grant is the ledger port only: feedback does not deliver into the agent, and candidate evidence stays on the package-admin port. Each request opens a new instance around that request's authority. There is no composition-root factory override.

A change to the feedback service code or its provider is restart-required. The daemon applies it on a controlled process restart and does not abort an in-flight feedback operation to swap code. Submitting feedback, generating a Skill candidate, and live-capable configuration do not require a restart. Restart stays compatible with existing feedback records and keeps idempotent candidate recovery. It does not repair an incompatible data format.

The platform authenticates local administration, checks session ownership, resolves mutation actors, serializes session commands, and provides durable ledger and candidate ports. The service preserves local-only feedback, cancellation, revision checks and human review. It must never infer authorization from payload fields or apply a draft. Ordinary backend extension code remains trusted in-process code.

The generated App Server method `_agnes/v1/admin.feedback` takes `action: 'list' | 'put' | 'withdraw' | 'generate'`. Mutations require `sessionId` and `expectedRevision` (null for first creation, otherwise the observed item's ledger sequence). `put` takes a `rating` and either a new `target` or an existing `id`; `category` and `note` are optional. A message target is `{messageSeq, turn}` on a settled main-lane assistant message. A session target uses null for both fields. Existing targets cannot be changed. Withdraw and generate address an existing item. Browser surfaces use same-origin `POST /api/feedback` through the local admin bridge.

`list` accepts optional `sessionId`, `category`, `rating`, `hasCandidate` filters and returns current items, growth provenance, aggregate counts and `truncated`. Item `revision` is a ledger sequence, not a timestamp. `candidateHash` on an item retains the generated candidate hash; each growth record resolves the current candidate hash and verified review/published metadata from the candidate owner. Unavailable candidate evidence cannot masquerade as approval. The original feedback revision and generated hash remain in the ledger even after edits.

The ignorable ledger events `x/feedback/item` and `x/feedback/growth` carry platform-stamped actors and timestamps in their envelopes. An item fact preserves author, target, creation/update time and withdrawal status. A growth link preserves `feedbackId`, `feedbackRevision`, `messageSeq`, `candidateId`, `candidateHash`. `AuthoringOrigin` adds optional `feedbackId`, `feedbackRevision`, `messageSeq`; the existing candidate review digest includes this origin, binding provenance to the reviewed source snapshot. Publication still requires the candidate's passing test hash and exact review hash.

These two names are explicitly reserved platform events in the protocol. Other `x/feedback/*` names are refused; plugin-owned events continue to use the documented extension namespace.

The append port enforces the fixed event family for every caller. It binds writes to the admitted session, re-checks local write authority, session ownership and the fitted actor on every append, and stamps the authenticated actor. `id()` issues new feedback item IDs; revisions may reuse only that actor's existing item in the same session. Growth links must identify an owned item revision and its message. Caller-selected item IDs, envelope ID fields, event types and actors are refused with `CAPABILITY_DENIED`. Envelope event IDs remain Host-generated. A read-only request supplies no write authority.

See [the user flow](../guide/feedback.md) and [candidate review](agent-built-plugins.md). The default drafts a new Skill, while memory continues through its existing explicit diff approval flow.

Growth retries recover the candidate by a server-bound profile/principal/session/feedback revision command key before drafting. Candidate persistence followed by a failed ledger link is repaired by linking that same integrity-checked candidate, including after reconnect; draft content is not regenerated. `FeedbackAuthority.recoverCandidate` runs before inference.

Tool-policy providers may implement `ToolPolicy.settings(context, signal)` to select a policy and interpret provider-owned JSON settings. Host supplies deployment context and forwards the selection without naming official policy IDs. The official approval provider owns `AutoReviewSettingsStore` at `@agnes/base/approval-policy`.
