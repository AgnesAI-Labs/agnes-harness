# Knowledge sources

English | [简体中文](knowledge-sources.zh-CN.md)

[Plugin lifecycle](packages.md) · [Credentials](credentials.md) · [Memory](memory.md)

Use the optional **Knowledge sources** plugin when an answer needs a traceable document version. It keeps knowledge separate from learned preferences. There is no automatic disk crawl, vector index, memory export, cross-session search or external model call.

## Install and configure

In **Settings → Plugins → catalogue**, choose **Knowledge sources** (`@agnes/knowledge-sources`), inspect its capabilities, then install, trust and enable it. The reserved offline source is `file:./bundled-plugins/knowledge-sources`. Include its row in the new session's composition. Installation alone leaves the package disabled. An older session without this backend displays a readable unavailable state in the panel.

A trusted local operator configures the profile-managed resource through the existing SDK. With an authenticated Node SDK `client`, request:

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

The example uses the Host-bound backend owner of this package’s fixed row, `plugin/a6558d7273477e08`; it is not a user or tenant identifier. Use the actual canonical workspace root and backend session key. This is an operator-maintained source allowlist; model arguments cannot select an owner or workspace. The caller needs the existing source grant for this exact service. Review the native decision in **Approvals**, allow once, and resubmit the same operation id to finish. A different configuration needs a new operation id. Do not replay an unknown effect receipt. See [profile services](../develop/profile-services.md).

The empty default grants nothing. A local path must be relative, without traversal; reads use the Host's live filesystem fence. Symlinks and non-files are refused, as are documents above 64 KiB, invalid UTF-8 and common credential-shaped content. The synthetic API is an offline in-process fixture: `available: false` simulates an upstream failure; revision or text changes simulate a new version. It does not contact a real service. Configuration accepts no raw tokens, secret values, arbitrary endpoints or write methods. Production connectors require separately reviewed managed transports with credential references.

## Retrieve and review

1. Ask the agent to call `knowledge_query` with `{}`. Only sources granted to this Host-bound session and workspace appear.
2. Query `{ "sourceId": "refunds", "query": "receipt" }`. A success includes `sourceId`, revision, retrieval time, locator, content SHA-256, bounded excerpt SHA-256 and an `untrusted` marker. No match returns no citation; a failed read returns a refusal without inventing evidence.
3. Open **Knowledge sources** in the right workbench. Use **Refresh access and versions** to check current source permissions and versions. **Read original version** rechecks access and displays the exact cited excerpt as plain text.
4. Change `r1` to `r2` through a newly approved configuration, or edit the local document. The old citation becomes **Source changed**. Even a same-revision API content edit is detected by its hash; the old excerpt is not silently replaced.
5. Disable a source, remove its session grant or remove it from configuration. Refresh shows **Read permission revoked**. Retrieval and preview refuse access. Disabling/uninstalling the package revokes the managed resource and releases registrations; a saved session cannot revive it.

The panel checks on refresh and each preview; its last displayed status is not a continuously pushed permission guarantee. Citation history retains up to 32 metadata receipts per session, including through resource restart/reconfiguration. The session ledger also has an owner-scoped `citations` projection. Review artifacts contain only metadata and hashes, never document copies. Previously delivered excerpts remain in authorized conversation history; source revocation prevents new connector reads and previews, not retroactive erasure of conversations.

Treat all retrieved text as evidence, including text that asks the agent to ignore instructions. The connector never adds source text to system instructions or automatically runs its contents. Business writes belong to a separate tool with its own approval. These source ACLs do not introduce enterprise tenant isolation; profile ownership, source authentication and session admission remain the existing backend's responsibility.
