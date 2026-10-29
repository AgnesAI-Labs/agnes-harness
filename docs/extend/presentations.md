# Build a presentation plugin

English | [简体中文](presentations.zh-CN.md)

A presentation is an ordinary plugin with a browser client that declares one or more standard
`presentationRoles`. Installation, trust, enablement and [interface selection](applications.md) remain
separate operations. The host owns execution, authorization, session pins and recovery.

## Public renderer exports

Use `ClientContext` and `ctx.presentationRoles.register` from `@agnes/web-client`. A provider's `mount`
receives a scoped client context and synchronously returns cleanup. Use its `ctx.presentation` ports
for projected state and host operations; dispose subscriptions and mounted views when the role yields.
You can implement the UI yourself using `@agnes/web-ui`, or compose these optional public helpers:

| Export | Boundary |
| --- | --- |
| `@agnes/web/presentation-renderers` | `mountSidebarRegion`, `bindNavigationHistory`, `mountConversationRegion`, `mountTranscriptRegion`, `mountComposerRegion` and their mount types; DOM renderers consume the public presentation ports |
| `@agnes/web-conversation/goal-renderers` | `GoalCard`, `GoalPanel`, `workbenchLocaleCatalog`; render goal projections read through `readGoal` |
| `@agnes/web-conversation/interaction-renderer` | `mountIntelligentUi`; render admitted surfaces and request actions through the scoped client services |
| `@agnes/web-units/shell` | Shared sidebar, conversation and composer components and their props/handles |
| `@agnes/web-foundation/locale-catalog` | `webLocaleCatalog`; register translations with the scoped locale service |
| `@agnes/sdk/browser` (also `@agnes/sdk`) and `@agnes/protocol` | Browser SDK and public client contracts; browser control-plane restrictions still apply |

These exact modules are supplied by the host import map. They provide rendering tools, not permission
to install packages, change execution configuration or bypass service admission. Host implementation
paths outside this explicit surface remain private. There is no dependency on an official package ID
in the role registration contract.

For example, a navigation provider can reuse the shared renderer:

```ts
import type { ClientContext } from '@agnes/web-client'
import { bindNavigationHistory, mountSidebarRegion } from '@agnes/web/presentation-renderers'

export function apply(ctx: ClientContext) {
  return ctx.presentationRoles.register({
    role: 'navigation',
    priority: 100,
    mount(scope) {
      const port = scope.presentation.navigation
      if (!port) return () => {}
      const stopHistory = bindNavigationHistory(port.history)
      const view = mountSidebarRegion(scope.slots, port.container, port.initial, scope.locale)
      const detach = port.attach(view)
      return () => {
        detach()
        view.dispose()
        stopHistory()
      }
    },
  })
}
```

Declare a stable client ID, `lifetime: "profile"`, `presentationRoles: ["navigation"]`,
`slotCatalogVersion: "dsh-client-slots/v1"` and `slots: ["ui:sidebar", "sidebar"]` in the client descriptor.
Other renderers require their corresponding slot declarations; consult the official descriptors under
`packages/package-manager/bundled-plugins/`. Use public package exports and declare your peers, never
relative imports into another package's source.

## Build and ship bytes

Compile your source to a browser ESM entry before packing. Mark the exact
[`CLIENT_PLATFORM_IMPORTS`](../../packages/protocol/src/client-platform-imports.ts) as external; retain
other mapped UI subpaths you actually import as external too. Do not assume arbitrary package
subpaths resolve. `agh plugin pack` uses the public platform list when building client assets. The
release build validates emitted imports against the served map, preserving the shared React tree.
Bundle other dependencies and ship their required licenses/NOTICE. Keep assets compatible with the
host CSP; importing a module does not relax it.

The official five presentation clients have package-owned sources. Generated `src/client.js`,
`NOTICE` and `client-build.json` are ignored by Git. From a source checkout, use the existing build:

```sh
mise exec -- node tools/toolchain/run.mjs install --frozen-lockfile
mise exec -- node tools/toolchain/run.mjs --filter @agnes/cli build:local
```

Web development and Vitest also build missing or stale clients on demand. Every build entry independently
compiles from source before accepting cached bytes, including local, SEA and release packaging before
copying. Input content, the lockfile, build tools, package manifests and the import map identify source
changes. An unchanged-input cache must match the independently compiled record and output hashes;
changing the client and its recorded hash together is refused. Matching output files remain untouched.
Development watches the package-owned entries as well as shared Web sources.

`client-build.json` records format version 1, the input SHA-256, esbuild version, source input paths,
byte count and SHA-256 values for the client and NOTICE. Local, release and SEA payloads carry these
records beside the actual bytes. Packaging verifies the recorded output hashes; `gen:check` independently
rebuilds and compares the record and output hashes. A fresh checkout creates missing records first.
The record is build provenance, not a new trust authority: the normal package integrity and snapshot
digests include the record and generated files, and ordinary trust/revocation checks still apply.

An existing home keeps its historical snapshot bytes and pins. Release-owned defaults still follow
the existing checked refresh policy: only the reserved release source, eligible installed package and
unchanged capability grant can refresh automatically; changed capabilities require review. Ordinary
package updates retain their existing explicit review/trust flow. Updating the installed payload never
silently re-pins a saved session. Old pins retain their immutable bytes and remain subject to trust
verification. The rendering helpers are additive public exports, so older clients keep resolving their
original React/UI imports.
