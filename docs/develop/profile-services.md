# Profile services and bound notifications

English | [简体中文](profile-services.zh-CN.md)

[Documentation](../README.md) · [Full-stack plugins](fullstack.md)

A profile service is available without opening a conversation. Declare `scope: 'profile'` on the backend service and include its exact name in the owning client module's `services` allowlist. Existing services default to session scope; their session APIs still require `sessionId`.

```ts
ctx.services.register({
  name: 'reports.publish', scope: 'profile', kind: 'effect',
  inputSchema, outputSchema, timeoutMs: 30000, maxResultBytes: 65536,
  effectPolicy: {
    isDestructive: true, isOpenWorld: true, replay: 'never',
    requiresApproval: 'always', approvalScopes: [],
  },
  async prepare(input, context) {
    return { input, resourceRevision: 'reviewed-resource-revision', presentation: { action: 'Publish report' } }
  },
  async handler(input, context) {
    // The Host supplies context.scope, actor, source, immutable admission.prepared and the consumed approval proof.
    return publishReviewedReport(input, context.signal)
  },
})
```

Preparation must be bounded and read-only. Prepared data and the complete native decision request are each limited to 128 KiB; oversized review data is refused before dispatch. It receives query authority. The Host binds the original and prepared inputs, resource revision, reviewed policy, actor, source, package integrity and current activation to the decision. A changed subject needs a new operation id and approval. Never interpret an input field such as `approved`, `role` or `actor` as authority.

In a client module, use `ctx.profile.services.query(name, input)`, `effect(name, input, { operationId })` and `readOperation(name, operationId)`. The same-origin relay checks the current ready row and its exact service allowlist. Profile identity and backend owner are selected by the server. Node clients use `client.extensions.callScoped` and `readOperation` under their authenticated source grants.

Service and bound-producer grants match the registered provider version. An unrestricted `*` grant includes valid prerelease versions. Other ranges admit a prerelease only when they explicitly opt into that same major/minor/patch tuple, following the shared supported range rules; ordinary stable ranges reject prereleases. Exact owner and service names, current activation and native admission are still required.

A query that filters session-owned records can request `query(name, input, { sessionReads: [sessionId] })`. The authenticated ingress checks every requested id with the existing durable session-owner gate. These ids request access; they do not grant it. The handler must call `context.sessionAccess.requireRead(sessionId)` before applying such a filter. Missing, foreign or unrequested ids fail closed. At most 16 ids are admitted, and this scope is query-only; it opens no session and provides no session mutation port. Node `callScoped` accepts the same `sessionReads` request. Trusted embeddings must obtain the resolved scope from their authenticated owner gate.

Effects return `approval-required`, `running`, `completed`, `refused`, `cancelled` or `unknown` receipts. An approval-required receipt contains the existing durable DecisionRequest handle. Open **Approvals** at the bottom of the Web sidebar, even with no selected conversation. The host-owned card displays the immutable subject and offers **Allow once** and **Reject**. After approval, retry the original effect with the same operation id. The plugin's own confirmation dialog does not authorize execution. Profile approval uses the native durable decision primitive and conservative manual risk policy; it does not inherit a conversation's full-access setting.

Decision consumption and dispatch intent commit atomically in the existing ledger. A completed receipt is replayed without executing again. A dispatch whose terminal receipt is lost becomes `unknown` after restart, including for an idempotent declaration; reconcile the external outcome before starting another operation. A reused id with different parameters is rejected. Disable, untrust, changed row configuration and package replacement invalidate old authority. Restoring a pinned session does not publish profile activation or restore a control grant.

Profile contexts have no session, workspace, child-job cancellation, process or arbitrary jobs port. Their filesystem and artifact mutation methods refuse access. Network access remains constrained by the package declaration and deployment allowlist. Query networking is limited to GET/HEAD with no body.

A reviewed effect can declare `priority: 'urgent'` for a separate bounded dispatch lane. This does not relax its approval policy. An effect that establishes temporary control can declare `controlLeaseMs` from 1 to 30,000. The Host records a subject-bound grant and expiry atomically with dispatch; `context.admission.controlGrant` exposes it to the handler. The trusted stream gateway must call `Host.profileServices.authorizeControl` with its authenticated source credential before using the operation as control authority. The plugin remains responsible for resource limits, release, expiry handling and safe shutdown.

## Session display and control

A profile client can bind a session display through `ctx.sessionStreams.open(name, input, options)`. The Host selects the ready active session; changing sessions aborts pending and live streams. Declare a session stream with `readService` naming an own session query, and include both the stream and service in the client allowlists. Before dispatch the gateway calls this query under authenticated session authority to check resource ownership. A profile client does not acquire arbitrary-session access.

Use `ctx.agnes.services.effect(name, input, { operationId })` for a session effect with a stable request id. After uncertain transport failure retry the same id and identical input. Session effects retain the existing native authorization, approval, journaling and refusal behavior. This API requires a ready active session and an exact service allowlist.

A session effect with `controlLeaseMs` may also declare `controlSessionMs` up to 300,000, at least as long as the lease. The handler receives `context.controlGrant`; native authority becomes usable only after a successful handler, output validation and audit. The trusted gateway uses `Host.authorizeServiceControl` to issue short leases bound to that original request, complete actor, source, input, session and backend registration. Renewal cannot exceed the original control session. Restart, revocation and expiry require new admission; restoring a ledger receipt does not restore control authority.

## Owner state and notifications

Declare `capabilities.store: true` for the bounded `context.store` port, available to profile services and admitted plugin tools. Keys and values stay inside the loader-selected owner/profile namespace. Values are limited to 64 KiB, with at most 10,000 keys and 16 MiB per namespace. `transaction` commits synchronously: returning a Promise rolls back, and continuations of that rejected transaction cannot write later. Use `scan({ prefix, limit, cursor? })` for bounded keyset pagination (1–256 rows). Query and preparation contexts receive a read-only view. No SQL or alternate-owner selector is exposed. This synchronous `OwnedStore` is distinct from the asynchronous revisioned `ManagedOwnedStore` supplied by `ManagedServiceInit`; managed processes use that runtime-owned store directly.

Declare `capabilities.wake: true` to receive `context.wake.bind()` in an admitted session tool. The Host persists the owner, package integrity, activation, session, original lane and generation; the returned target only exposes `bindingId`. Persist that target alongside the accepted operation. Record a terminal result and an outbox item in one owner-store transaction.

The authenticated producer's Node SDK can submit the outbox item:

```ts
await client.extensions.wakes.enqueue({
  target,
  idempotencyKey: `${operationId}/result-1/${target.bindingId}`,
  event: { name: 'report.completed', summary: 'The reviewed report finished.', data: { operationId } },
})
```

The producer needs an exact source grant for its own owner and `wake.enqueue`; a binding id alone is insufficient. This path exposes neither jobs administration nor an arbitrary session selector. Notifications use the existing durable jobs queue, recheck activation at enqueue and delivery, and atomically deduplicate the original session input with a stable command id. Missing lanes or changed generations refuse delivery. Summaries are limited to 2,048 characters. Notifications enter as untrusted system facts. Delivery currently uses `next-turn`, including requests for `follow-steer`.

A revoked target yields a terminal refusal; it is not transferred to another session or activation. Ordinary jobs APIs reject the internal notification payload. Preserve operation safety receipts and undelivered outbox items independently of any activity-display retention window.

These APIs are trusted-plugin contracts, not isolation for arbitrary JavaScript. New scope, risk, lease, store and wake declarations are strict schema fields; an older Host rejects them rather than silently granting fallback authority.

## Current-profile managed resources

Installed, trusted plugins can inject `profileRuntime`. Declare a profile `managedServices` entry with `artifact: { kind: 'in-process' }`, reviewed loopback listeners and bounded startup/shutdown deadlines. `ctx.profileRuntime.register({ id, configSchema, defaultConfig, start, check? })` registers the factory; it does not start a resource in a staged or pinned tree. Only current profile publication starts it in the shared Host worker. Session composition containers register factories without taking profile ownership. Startup finishes release-default refresh and pinned target publication before the first resource registration. Replacement drains the old resource first. `handle.get()` refuses obsolete or unready resources. This is trusted in-process execution; Node/OCI artifacts continue to use the separate process supervisor.

`start(init)` receives an owner-scoped store, bound notifications, selected listeners, validated configuration and a lifecycle signal. Install `init.onShutdown` before opening listeners, and call `init.ready()` only after recovery and binding. The Host drains managed shutdown before revoking plugin registrations and streams, and persists confirmed settlement. Without a verified late cleanup confirmation, an unconfirmed shutdown can recover automatically only when the recorded worker PID and start identity prove the old in-process owner is gone (including PID reuse). A live owner refuses restart; missing identity or a failed probe requires the reviewed reconciliation action below. This reconciles resource liveness only: unknown operation outcomes remain unknown and are never replayed. The generic `listenerPorts` configuration may select a port for an `auto` listener, but cannot change its host or override a reviewed fixed port.

If a ready resource's shutdown callback finishes after its deadline, the Host accepts its later `settled` result only for the same resource incarnation and recorded worker identity. The confirmation follows a blocked replacement and clears only that instance's shutdown marker, including when the plugin was disabled while cleanup continued. Existing retry, reconciliation or reactivation can then start the current factory without restarting the worker; the callback itself starts no resource. Unknown/rejected cleanup, changed instance or worker identity, and legacy records without this confirmation retain the conservative recovery rules. Operation outcomes remain unchanged, and the marker revision change invalidates earlier recovery decisions.

The Host registers `<id>.status`, `<id>.configuration`, `<id>.check`, `<id>.retry`, `<id>.reconcile` and `<id>.configure` as ordinary profile services. Include the exact names in the client allowlist. Status exposes safe listener addresses; configuration and retry require native approval. A plugin-provided check reports domain health through this same facade.

Declare streams and register them through `ctx.profileRuntime.streams.register(name, handler)`. The local launcher relays the same-origin stream gateway to the shared worker over a private connection. The current roster, scope, input schema, actor and native control grant are checked before dispatch. Browser code never receives the private worker endpoint or its connection proof. The generic transport implementation is shared in `@agnes/plugin-streams`; `@agnes/daemon-rpc/streams` remains a compatible entry.

The examples facade reports installation and managed runtime readiness separately. Stop disables the selected installed child example through package administration; relationship metadata only selects eligible children and does not grant them a parent's service authority.

Profile data producers may declare `producer: true` on an inbound profile stream in an events or media lane. They retain authenticated roster, exact-owner and activation checks, bounded buffers and revocation, but do not acquire motion/control authority. A trusted backend can use `profileRuntime.connectProducer` only for an exact `managedServices.requires` grant (backend owner, stream name, range `*`). Both child and parent activations are checked for every forwarded frame. Existing inbound control streams still require a consumed native effect grant.

The `local-dev` template permits reviewed store, wake, stream and managed-service declarations. Existing saved profile ceilings remain authoritative; this does not widen them or bypass package trust and effect approval.


### Confirm and recover

For a current-profile resource in `failed / shutdown-unconfirmed`, request the Host-owned `<id>.reconcile` effect with `{}` and a new operation id. Include this exact service in the client allowlist and reviewed capability declarations (use `managedServiceCapabilities` when declaring the facade). The authenticated source needs the exact service grant and the principal must be authorized to execute this resource administration action. Agents cannot request profile effects.

The Host accepts a verified late cleanup confirmation for the same instance, or checks the saved process identity. A verifiably dead owner, including a reused PID with a different start identity, can recover without a liveness confirmation. Missing identity or an unavailable probe requires a native AR1 decision naming the resource, owner package, generation and last known identity. When an update replaces the same package/service owner, its unconfirmed marker follows the replacement with the predecessor owner, activation identity and integrity; that predecessor is part of the decision binding. Older boolean-only markers still require one approval. **Allow once** means the operator confirms that the old process is no longer running. Without that cleanup confirmation, a matching live identity refuses recovery even after approval. Rejection, a changed generation/resource instance, a changed predecessor, or a changed shutdown marker revision leaves it locked; use a new operation id after reviewing the new state. Identity and revision are checked again before clearing the marker and starting the replacement. Recovery never signals a recorded PID and never resets or replays operation journals, receipts or device motions. Unknown operation outcomes remain unknown.

A local operator can use the same flow without opening a session:

```sh
node agnes.mjs runtime reconcile RESOURCE --extension ext:OWNER.ROW --operation recovery-1
# Read the returned native decision, verify the old process has stopped, then answer it:
node agnes.mjs runtime reconcile RESOURCE --extension ext:OWNER.ROW --operation recovery-1 --answer allow
# Or keep the resource locked:
node agnes.mjs runtime reconcile RESOURCE --extension ext:OWNER.ROW --operation recovery-1 --answer reject
```

Use the installed plugin's row id and managed resource id; `--profile NAME` selects the profile. The command prints JSON receipts and the native review subject. Exit 0 means completed, 3 means approval-required/running, and 1 means a terminal refusal or unknown outcome. Approval can also be answered in Web **Approvals**; resubmit the same operation id to finish. Never retry an unknown operation as though it had failed before dispatch.
