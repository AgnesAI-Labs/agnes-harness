import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Window } from 'happy-dom'
import { createWorkbenchShell } from '../../../../examples/runtime-reference/src/client/workbench-shell.js'
import { bindShellContract } from '../../../../examples/runtime-reference/src/providers/shell.js'
import type { ShellProvider } from '../../../../packages/extension-api/src/client/index.js'
import {
  recoverShell,
  registerShellContract,
  type ShellConformanceBinding,
} from '../../../../packages/extension-api/testkit/runtime/contracts/shell.js'
import {
  holdUIRegistryClient,
  restartUIRegistryClient,
} from '../../../../packages/extension-api/testkit/runtime/contracts/ui-registry.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.js'
import { createClientHostRuntime } from '../../../../packages/web-client/src/runtime/client-host.js'
import { resolveClientSelection } from '../../../../packages/web-client/src/runtime/client-selection.js'
import { getConformanceBuildIdentity, withConformanceBuild } from '../build-identity.js'

const CONTRACT = 'agh.shell'
const PROVIDERS = ['default', 'reference'] as const
type Provider = (typeof PROVIDERS)[number]
const RECIPE = 'packages/web/src/runtime/providers/shell.ts'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const self = fileURLToPath(import.meta.url)
const sha256 = (path: string) =>
  createHash('sha256')
    .update(readFileSync(join(root, path)))
    .digest('hex')

// The shell each provider names. The Web client's default chat shell shows its own English text; it is
// loaded only when asked for, so runs of other contracts do not load the Web UI layer.
const SHELLS: Record<Provider, () => Promise<() => ShellProvider>> = {
  reference: async () => createWorkbenchShell,
  async default() {
    const { createDefaultShell, defaultShellLocale } = await import(
      '../../../../packages/web/src/runtime/providers/shell.js'
    )
    const locale = defaultShellLocale('en')
    return () => createDefaultShell(locale)
  },
}

// Every container is a fresh element in one happy-dom document. The runner has no teardown, so the
// document lives until the process exits.
let window: Window | undefined
function container(): HTMLElement {
  window ??= new Window()
  return window.document.body.appendChild(window.document.createElement('div')) as unknown as HTMLElement
}

type HostInput = Parameters<typeof createClientHostRuntime>[0]

// The web client's own selection and client host: each catalog builds one generation in a fresh host
// over the case's loader, and the shell is that generation's.
const select: ShellConformanceBinding['select'] = async ({ modules, selection, load }) => {
  const resolved = resolveClientSelection({ target: 'web', selection, modules })
  if (!resolved.ok) return resolved
  if (resolved.value.kind !== 'selected') throw new Error('the selection resolved to the legacy path')
  const host = createClientHostRuntime({
    target: 'web',
    loader: { load },
    // The cases' modules read neither their context nor the presenter, and their registry binds no
    // renderer, so nothing is presented.
    clientInstanceId: 'shell-conformance',
    capabilities: {} as HostInput['capabilities'],
    locale: {} as HostInput['locale'],
    presenter: {
      lease: () => {
        throw new Error('nothing is presented while a shell is selected')
      },
      generic: () => {
        throw new Error('nothing is presented while a shell is selected')
      },
    },
  })
  const activated = await host.activate({ revision: 1, modules, selection: resolved.value })
  if (!activated.ok) return activated
  const shell = host.current()?.shell()
  if (shell === undefined) throw new Error('the generation offers no shell')
  return { ok: true, value: shell }
}

// The client processes run this file, which selects the provider's shell through the same host into the
// same DOM. The UI registry's client process runner kills the first on READY and waits for the second to
// exit.
const restart =
  (provider: Provider): ShellConformanceBinding['restart'] =>
  (directory) =>
    restartUIRegistryClient(['--import', 'tsx', self, directory, provider], root)

// The Web client's default chat shell and the reference workbench shell bind here.
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
  for (const providerId of providers) {
    if (providerId === 'reference')
      bindShellContract(withConformanceBuild(harness), request.command, {
        providerId,
        container,
        select,
        restart: restart(providerId),
      })
    else
      registerShellContract(harness, {
        providerId,
        recipe: RECIPE,
        command: request.command,
        build: getConformanceBuildIdentity(),
        providerDigest: sha256(RECIPE),
        configDigest: canonicalJsonDigest({}),
        releaseSetDigest: sha256('packages/web/package.json'),
        shell: await SHELLS[providerId](),
        container,
        select,
        restart: restart(providerId),
      })
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
  SHELLS[provider as Provider]()
    .then((shell) => recoverShell({ shell, container, select }, directory, holdUIRegistryClient))
    .then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : 'shell client failed'}\n`)
        process.exit(1)
      },
    )
}
