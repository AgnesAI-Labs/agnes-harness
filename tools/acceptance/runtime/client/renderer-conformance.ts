import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Window } from 'happy-dom'
import {
  bindRendererContract,
  referenceOutlineRenderers,
} from '../../../../examples/runtime-reference/src/providers/renderer.ts'
import type {
  DomainView,
  RendererDefinition,
  RendererDescriptor,
} from '../../../../packages/extension-api/src/client/index.ts'
import {
  type RendererConformanceBinding,
  recoverRenderer,
  registerRendererContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/renderer.ts'
import {
  holdUIRegistryClient,
  restartUIRegistryClient,
} from '../../../../packages/extension-api/testkit/runtime/contracts/ui-registry.ts'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.ts'
import { createClientHostRuntime } from '../../../../packages/web-client/src/runtime/client-host.ts'
import { resolveClientSelection } from '../../../../packages/web-client/src/runtime/client-selection.ts'
import { getConformanceBuildIdentity, withConformanceBuild } from '../build-identity.js'

const CONTRACT = 'agh.renderer'
const PROVIDERS = ['default', 'reference'] as const
type Provider = (typeof PROVIDERS)[number]
const RECIPE = 'packages/web-client/src/runtime/providers/renderer.ts'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const self = fileURLToPath(import.meta.url)
const sha256 = (path: string) =>
  createHash('sha256')
    .update(readFileSync(join(root, path)))
    .digest('hex')

/** The view the default renderer's cases present; the default presents any view its descriptor names. */
const DEFAULT_VIEW: DomainView = {
  kind: 'domain',
  viewId: 'conformance-card-1',
  revision: 1,
  domainType: 'conformance.card',
  viewSchema: { typeId: 'conformance.card/view@1', revision: 1, digest: 'b'.repeat(64) },
  renderKey: 'conformance.card',
  scope: {
    kind: 'session',
    installationId: 'installation-1',
    runtimeId: 'runtime-1',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
  },
  source: { eventIds: ['event-1'], projectionRevision: 1 },
  phase: 'finalized',
  fallbackText: 'A conformance card',
  data: {},
  resources: [],
  actions: [],
}

/** The catalog's declaration of the default renderer for that view, in the web client's package. */
const DEFAULT_DESCRIPTOR: RendererDescriptor = {
  id: 'agh.default-renderer',
  packageDigest: sha256('packages/web-client/package.json'),
  renderKey: DEFAULT_VIEW.renderKey,
  targets: ['web', 'tui', 'sdk', 'im'],
  viewSchemaRanges: [{ typeId: DEFAULT_VIEW.viewSchema.typeId, minRevision: 1, maxRevision: 1 }],
  requiredFeatures: [],
  optionalFeatures: [],
  scope: 'view',
  entry: './src/runtime/providers/renderer.ts',
}

// The renderers each provider names. The default renderer shows the Web client's generic card, which
// loads the Web UI layer; it is loaded only when asked for, so runs of other contracts do not load it.
const RENDERERS: Record<Provider, () => Promise<readonly RendererDefinition[]>> = {
  reference: async () => referenceOutlineRenderers,
  async default() {
    const { createDefaultRenderer } = await import(
      '../../../../packages/web-client/src/runtime/providers/renderer.ts'
    )
    return [createDefaultRenderer(DEFAULT_DESCRIPTOR)]
  },
}

type Host = Pick<RendererConformanceBinding, 'root' | 'select'>
type HostInput = Parameters<typeof createClientHostRuntime>[0]

/**
 * The web client's own selection, client host and presenter, and React roots over one happy-dom
 * document. Loaded on first use, as both reach the Web UI layer.
 */
let loading: Promise<Host> | undefined
function webHost(): Promise<Host> {
  loading ??= (async () => {
    // tsx compiles TSX under the repository's root tsconfig, which names no JSX runtime, so the presenter,
    // the generic card and the reference outline call the classic `React.createElement` there; Vitest
    // takes each package's automatic runtime instead. Both render with the web client's one React.
    // React DOM and the Web UI layer also read the global window and document while they commit. The
    // runner has no teardown, so all three stay until the process exits.
    const scope = globalThis as { React?: unknown; window?: unknown; document?: unknown }
    scope.React ??= createRequire(join(root, 'packages/web-client/package.json'))('react')
    if (scope.window === undefined) {
      const window = new Window()
      const getComputedStyle = window.getComputedStyle.bind(window)
      Object.assign(scope, { window, document: window.document, getComputedStyle })
    }
    const document = scope.document as Document
    const [{ createRendererPresenter }, { renderRegion, unmountRegion }] = await Promise.all([
      import('../../../../packages/web-client/src/runtime/renderer-presentation.tsx'),
      import('../../../../packages/web-ui/src/regions.ts'),
    ])
    const reactRoot: Host['root'] = () => {
      const container = document.body.appendChild(document.createElement('div'))
      return {
        container,
        render: (element) => renderRegion(container, element),
        unmount: () => {
          unmountRegion(container)
          container.remove()
        },
      }
    }
    // Each catalog builds one generation in a fresh host over the case's loader and window.
    const select: Host['select'] = async ({
      target,
      modules,
      selection,
      load,
      views,
      capabilities,
      locale,
      services,
    }) => {
      const resolved = resolveClientSelection({ target, selection, modules })
      if (!resolved.ok) return resolved
      if (resolved.value.kind !== 'selected') throw new Error('the selection resolved to the legacy path')
      const presenter = createRendererPresenter({
        target,
        clientInstanceId: capabilities.clientInstanceId,
        capabilities,
        locale,
        services,
        views,
      })
      // The cases' modules have no client entry, so nothing reads the module context.
      const host = createClientHostRuntime({
        target,
        loader: { load },
        context: {} as HostInput['context'],
        presenter,
      })
      const activated = await host.activate({ revision: 1, modules, selection: resolved.value })
      if (!activated.ok) return activated
      const generation = host.current()
      if (generation === undefined) throw new Error('the activated host holds no generation')
      return { ok: true, value: { presentation: generation.presentation, release: () => host.dispose() } }
    }
    return { root: reactRoot, select }
  })()
  return loading
}

// The client processes run this file, which presents through the same host into the same DOM. The UI
// registry's client process runner kills the first on READY and waits for the second to exit.
const restart =
  (provider: Provider): RendererConformanceBinding['restart'] =>
  (directory) =>
    restartUIRegistryClient(['--import', 'tsx', self, directory, provider], root)

// The Web client's default renderer and the reference slide outline renderers bind here.
export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  if (request.contracts !== 'all' && !request.contracts.includes(CONTRACT))
    return { contracts: [], providers: [] }
  const providers = PROVIDERS.filter((providerId) => request.providers.includes(providerId))
  if (providers.length > 0) {
    const { root: reactRoot, select } = await webHost()
    for (const providerId of providers) {
      if (providerId === 'reference')
        bindRendererContract(withConformanceBuild(harness), request.command, {
          providerId,
          root: reactRoot,
          select,
          restart: restart(providerId),
        })
      else
        registerRendererContract(harness, {
          providerId,
          recipe: RECIPE,
          command: request.command,
          build: getConformanceBuildIdentity(),
          providerDigest: sha256(RECIPE),
          configDigest: canonicalJsonDigest({}),
          releaseSetDigest: sha256('packages/web-client/package.json'),
          renderers: await RENDERERS[providerId](),
          view: DEFAULT_VIEW,
          root: reactRoot,
          select,
          restart: restart(providerId),
        })
    }
  }
  return { contracts: [CONTRACT], providers }
}

// The client process `recover` starts: `<directory> <provider>`. The rebuilt one exits once it has
// recorded what it saw, whatever the DOM still holds open.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const [directory, provider] = process.argv.slice(2)
  if (directory === undefined || !PROVIDERS.includes(provider as Provider))
    throw new Error('expected: <directory> <default|reference>')
  Promise.all([RENDERERS[provider as Provider](), webHost()])
    .then(([renderers, host]) => recoverRenderer({ ...host, renderers }, directory, holdUIRegistryClient))
    .then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : 'renderer client failed'}\n`)
        process.exit(1)
      },
    )
}
