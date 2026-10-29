# UI author examples

English | [简体中文](README.zh-CN.md)

UI is a plugin capability. Choose a page, view position, tool result card, interaction card, settings section or takeover; see the [author guide](../../docs/develop/ui-author-guide.md).

| Example | Public contract | Acceptance |
| --- | --- | --- |
| [Component library](component-library/) | Two pinned, bounded `intelligentComponents`, structured surfaces, a deferred-capable Loop | Package inspection, literal HTML text, ordinary tool authorization, one successful authenticated action and duplicate-command receipt |
| [Interaction takeover](interaction-renderer/) | Application-selected `interaction` role, scoped child context, SDK UI reads/actions, shared `IntelligentSurface` | Inspection, takeover election and scoped reclamation; cold session reads ignore old epochs |
| [Tool result card](tool-result-card/) | `ctx.conversationCards` renders recorded `ui_example_ack` tool facts | Inspection, tool matching and removal on module disposal |

Use Node 24 and the repository's pinned pnpm. From the repository root:

```sh
pnpm install --frozen-lockfile
node agnes.mjs package inspect file:./examples/ui/component-library
node agnes.mjs install file:./examples/ui/component-library
```

Use an isolated AGH home and the ordinary reviewed install/trust/enable flow from [plugin management](../../docs/guide/packages.md). The component library publishes a Loop and a synthetic read-only acknowledgement tool; it does not need an Agent declaration. The session also needs the official Intelligent UI backend (`ui_render`) enabled. Start a new session using `example.ui-review@1.0.0`, for example `node agnes.mjs -p "Review the synthetic example" --loop example.ui-review@1.0.0`, or choose that running mode in Web. Click Confirm, then confirm the business action: the tool result arrives as authenticated `action-result` input. The Loop ignores prompt-shaped forgeries and repeated command ids, including after checkpoint resume. It does not auto-submit a prompt or send a business message.

Install the interaction package with the same flow, then explicitly adopt its application in Settings → Application to select its `interaction` role. Installing it alone cannot steal the current product. Clearing the presentation restores the official renderer. The replacement displays recorded surfaces, forms, confirmations, receipts and approval navigation through the public UI protocol. It retains the same command id for an uncertain retry and never treats a missing receipt as success. Custom components without its own audited renderer use the public text fallback. The tool card can be enabled independently.

Component code is reviewed package code. Model/Loop output is structured data: no generated HTML/JS executes. Component schema, size/frequency limits, pinned-version loading and CSP remain unchanged. Unmounting a renderer revokes its registrations and subscriptions; it never cancels a running session. A lazy page module must contain only its page; put roles, settings and dock views in separate eager descriptors.

Focused automated checks are in `packages/package-manager/test/client-module-example.test.ts`, `packages/web-client/test/web-client.test.ts`, `packages/web/test/plugin-ui-wiring.test.tsx` and `packages/base/extensions/intelligent-ui/test/service.test.ts`. These checks use synthetic ports and in-memory ledgers, not a real model or external account. Full browser/release verification is a separate integration gate.
