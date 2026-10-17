# @agnes/knowledge-sources

English | [简体中文](README.zh-CN.md)

An optional official knowledge connector plugin. Install **Knowledge sources** from the built-in plugin catalogue, review its capabilities, trust and explicitly enable it. It is not bootstrapped into new profiles. Its one deferred tool is available only in sessions that include this plugin.

See the [user guide](../../../../docs/guide/knowledge-sources.md) for configuration and a walkthrough. The backend uses only public tools, services, events, projections, filesystem/artifact ports and a profile-managed resource; it adds no Core/Host contract. The Web panel uses the shared web-ui controls and returns its registration disposer.

- `knowledge_query({})`: list this session's authorized source IDs.
- `knowledge_query({sourceId, query?})`: retrieve one literal match with a bounded excerpt and citation.
- `knowledge.history`: session-bound source list and the latest 32 citation receipts with live access/version checks.
- `knowledge.preview({id})`: revalidate and show the exact cited excerpt only while that source version remains readable.
- `knowledge.configure`: the existing managed-resource profile effect, requiring native operator approval. Default configuration is `{ "sources": [] }`.

The initial connectors are explicitly selected local documents and an **offline, in-process synthetic API**. Neither connector opens arbitrary endpoints, loads credentials or writes business systems. Production remote adapters must use reviewed managed transports and credential references; they must never expose credential values. Knowledge is not a memory provider and does not alter memory, system instructions, Skills or AGENTS.md.

Limits: 16 sources, 32 session grants per source, 64 KiB per document, 2 KiB UTF-8 per excerpt, 32 metadata receipts per session. Source text stays untrusted and is rendered as plain text. Revision, content/excerpt SHA-256, excerpt location and retrieval time remain inspectable. Evidence artifacts contain metadata only; existing conversation text cannot be retroactively erased by source revocation. Receipt identity uses the Host-bound workspace and session key, within the Host-owned profile/package store. This is source ACL enforcement, not a new enterprise tenancy system.

Run from the repository root:

```sh
pnpm exec tsc -b packages/package-manager/bundled-plugins/knowledge-sources packages/package-manager/bundled-plugins/knowledge-sources/tsconfig.test.json
pnpm exec vitest run packages/package-manager/bundled-plugins/knowledge-sources/test --project fast --maxWorkers=1
pnpm --filter @agnes/knowledge-sources gen:check
```

Configuration/manifest contracts originate in `src/contracts.ts`; regenerate the package capability declaration with `pnpm --filter @agnes/knowledge-sources manifest` after changing them. Package code is original Apache-2.0 implementation; no third-party harness code, prompts, assets or dependencies were imported for this feature.
