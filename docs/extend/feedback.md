# Feedback services

English | [简体中文](feedback.zh-CN.md)

`@agnes/extension-api` exports `FeedbackService`, `FeedbackServiceFactory`, `FeedbackPorts`, `FeedbackRequest`, `FeedbackResult`, `FeedbackItem`, `FeedbackTarget`, `FeedbackGrowth`, `FEEDBACK_EVENT` and `FEEDBACK_GROWTH_EVENT`. The official default `createFeedbackService(ports)` implements this contract. An embedding daemon can pass `feedbackServiceFactory` to `startSupervisor` to replace the service. This is a composition-root service factory, not an ordinary runtime provider row.

```ts
interface FeedbackService {
  execute(input: FeedbackRequest, actor: Actor, signal: AbortSignal): Promise<FeedbackResult>
}
type FeedbackServiceFactory = (ports: FeedbackPorts) => FeedbackService
```

The platform authenticates local administration, checks session ownership, resolves mutation actors, serializes session commands, and provides durable ledger and candidate ports. A replacement uses these ports and must preserve local-only feedback, cancellation, revision checks and human review. It must never infer authorization from payload fields or apply a draft. Ordinary backend extension code remains trusted in-process code.

The generated App Server method `_agnes/v1/admin.feedback` takes `action: 'list' | 'put' | 'withdraw' | 'generate'`. Mutations require `sessionId` and `expectedRevision` (null for first creation, otherwise the observed item's ledger sequence). `put` takes a `rating` and either a new `target` or an existing `id`; `category` and `note` are optional. A message target is `{messageSeq, turn}` on a settled main-lane assistant message. A session target uses null for both fields. Existing targets cannot be changed. Withdraw and generate address an existing item. Browser surfaces use same-origin `POST /api/feedback` through the local admin bridge.

`list` accepts optional `sessionId`, `category`, `rating`, `hasCandidate` filters and returns current items, growth provenance, aggregate counts and `truncated`. Item `revision` is a ledger sequence, not a timestamp. `candidateHash` on an item retains the generated candidate hash; each growth record resolves the current candidate hash and verified review/published metadata from the candidate owner. Unavailable candidate evidence cannot masquerade as approval. The original feedback revision and generated hash remain in the ledger even after edits.

The ignorable ledger events `x/feedback/item` and `x/feedback/growth` carry platform-stamped actors and timestamps in their envelopes. An item fact preserves author, target, creation/update time and withdrawal status. A growth link preserves `feedbackId`, `feedbackRevision`, `messageSeq`, `candidateId`, `candidateHash`. `AuthoringOrigin` adds optional `feedbackId`, `feedbackRevision`, `messageSeq`; the existing candidate review digest includes this origin, binding provenance to the reviewed source snapshot. Publication still requires the candidate's passing test hash and exact review hash.

See [the user flow](../guide/feedback.md) and [candidate review](agent-built-plugins.md). The default drafts a new Skill, while memory continues through its existing explicit diff approval flow.

Growth retries recover the candidate by a server-bound profile/principal/session/feedback revision command key before drafting. Candidate persistence followed by a failed ledger link is repaired by linking that same integrity-checked candidate, including after reconnect; draft content is not regenerated. `FeedbackPorts.recoverCandidate` is required for providers implementing this workflow.

Tool-policy providers may implement `ToolPolicy.settings(context, signal)` to select a policy and interpret provider-owned JSON settings. Host supplies deployment context and forwards the selection without naming official policy IDs. The official approval provider owns `AutoReviewSettingsStore` at `@agnes/base/approval-policy`.
