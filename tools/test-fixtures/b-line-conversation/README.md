# B-0 conversation spike

This isolated Vitest/happy-dom fixture evaluates the 2026-09-24 Line B proposal against the current Agnes projection and DSH boundaries. It does not change the Web app, its vendor pipeline, or production `timeline.ts`. The converter in `src/projection.ts` is evidence-gathering code, not a production adapter.

## Reproduce

From the repository root, using Node.js >=24.10 and pnpm 10.34.5:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm install --dir tools/test-fixtures/b-line-conversation --frozen-lockfile
pnpm --dir tools/test-fixtures/b-line-conversation typecheck
pnpm --dir tools/test-fixtures/b-line-conversation test
```

The root installation provides the checked-out Agnes modules; the nested lockfile pins the spike dependencies. Four `it.fails` tests intentionally retain observed counterexamples. A green Vitest exit therefore means 10 positive checks and 4 known failures were reproduced, not that all migration acceptance criteria passed.

## Results at `d7ed0060d3ff80c93437075e15f23639c443ade6`

| Question | Observed result | Evidence |
| --- | --- | --- |
| Can the real external-store hook carry 11 `UINode` kinds? | Nine current chat-visible kinds render with stable node IDs; `context` and `context-sections` stay out of chat while remaining in the source projection. Same-ID assistant/tool/approval/cost and `UITurn.finalAssistantId` changes render without outbound requests. | `src/runtime.test.tsx`; `src/projection.ts` |
| Which dependency pairing works with React 18.3.1? | `@assistant-ui/react@0.11.4` crashed on `AssistantRuntimeProvider` because it rendered a context directly. `0.11.27` with the resolver-selected `@assistant-ui/tap@0.1.5` then failed while reading the initial thread state; the locked `0.11.27` + `0.1.2` pair passed this fixture. These observations are pairing-specific, not a compatibility claim for every 0.11 release. | Initial failed runs; nested `package.json` and lockfile; [upstream React 18 fix](https://github.com/assistant-ui/assistant-ui/pull/2494) |
| Does the `messages` array handle history prepend? | No. After rendering `a2` and then `[u1,a1,a2]`, only `u1,a1` remained visible. A full `ExportedMessageRepository.fromArray` import yielded the expected three messages and cleared on reset. | `src/runtime.test.tsx` positive and expected-failure checks |
| Does the existing DSH slot survive ordinary reconciliation? | Yes with the actual `mountSlotCard` and web-client `SlotOutlet`/registry: static fallback, claim, same-ID update, unrelated registration, removal fallback, and unmount were observed. | `src/slot.test.tsx` positive checks |
| Does `ThreadPrimitive.Messages` keep a stateful slot during history prepend? | No. Its index-keyed list remounted the slot host; the plugin counter changed from `1` to `0`. A manually ID-keyed `MessageByIndex` attempt threw `tapLookupResources: Resource not found for lookup: {"index":1}`. A web-owned ID-keyed leaf driven by runtime state retained the same host, button, and counter. | `src/slot.test.tsx`: two expected failures and one passing fallback |
| Does SSE hot reload preserve plugin-local React state after replacing its registration? | No in the current `mountSlotCard` boundary: a synthetic `rebuilt` event through the real `startPluginHotReload` consumer removed/re-registered the component and the counter reset from `1` to `0`. Ordinary registry updates did not reset it. This separates a component replacement from an assistant-ui reconciliation regression. | `src/slot.test.tsx` expected failure and positive ordinary-update check |
| Can 480ms suffix fade work under a stable React shell? | Yes using the current Markdown renderer as a stable child: only appended suffixes gained reveal fragments, prior fragments and paragraphs stayed, and background/reduced-motion/selection/focused code-control cases behaved as checked. A fully React-managed Markdown tree was not tested. | `src/reveal.test.tsx` |

## Candidate migration contract

1. Keep the backend/SDK projection authoritative. Feed `UINode[]` and `UITurn[]` into the UI adapter from the existing Web call chain. Preserve `node.id` as the message key and use `metadata.custom` only for UI classification, not authorization or execution.
2. Use a complete repository import for bounded openings, history prepend, and session replacement, or a separately demonstrated equivalent; the plain `messages` array path failed the observed prepend sequence. Test cost of full imports on the 500-node Web opening before locking B-2.
3. Keep DSH slot roots in a web-owned, ID-keyed leaf or an equivalently proven boundary. The default assistant-ui message list cannot own their lifecycle across history prepend. The existing chat/tool dataset hosts and hot-reload reconciliation still need real integration tests in B-4.
4. For Markdown, the proven path is an imperative renderer inside a stable React-owned shell. A complete no-`createElement` React replacement still requires a separate B-5 proof for rich Markdown, selection and code-copy controls; this spike does not waive the overall migration goal.
5. Treat plugin component replacement during SSE reload as a product-contract question. The current renderer already resets component-local state on replacement. Do not promise state preservation without a persistent plugin state contract and a separate integration check.

## Node decisions for the next stage

| Kind | Proposed carrier | State and fallback |
| --- | --- | --- |
| `user` | user message component | `node.id`; source content blocks; Web remains send authority |
| `assistant` | assistant message component | `node.id`; thinking/text/streaming/lostChars from projection; current Markdown shell is proven fallback |
| `tool` | custom assistant message branch | `node.id`; backend status/summary and existing web-units/DSH toolview; do not infer execution from a tool-call part |
| `approval` | custom assistant message branch | `node.id`; backend state/options; keep approval action in its existing owner |
| `cost` | custom assistant message branch | `node.id`; estimated→gateway same-ID update; preserve usage disclosure state |
| `artifact` | custom assistant message branch | `node.id`; name/ref only; rightbar document preview is separate |
| `compaction` | custom assistant message branch | `node.id`; summary/range fallback |
| `slot` | web-owned ID-keyed DSH leaf | `node.id`; `mountSlotCard` + registry/claim/static fallback; avoid default index-keyed message list |
| `contribute-conflict` | custom assistant message branch | `node.id`; key/ops visible with note semantics |
| `context` / `context-sections` | no chat message | Keep in full projection/trace; current `conversation-visibility.ts` filters them from chat |

This table is a spike decision proposal. The B-2/B-3 public prop shape, DSH chat/tool host details, full React Markdown path, and the SSE state contract remain to be settled before a production migration.

## Verification limits

- This is happy-dom with a synthetic registry/SSE source, not a real browser, daemon, plugin module swap, CSP page, or network interruption.
- The spike imports the current `mountSlotCard` and Markdown renderer, so it checks actual existing adapters but does not demonstrate a new production integration.
- The 63-slot catalog, toolview/chat dataset containers, and 500-node performance were not exhaustively verified by this fixture. Existing focused Web tests passed separately during the spike.
- Dependency origin: `@assistant-ui/react@0.11.27` and `@assistant-ui/tap@0.1.2` are MIT-licensed upstream packages used only by this isolated fixture; their package licenses remain in `node_modules` after installation. The nested lockfile records exact resolved versions; no assistant-ui runtime dependency was added to the shipped Web app.
