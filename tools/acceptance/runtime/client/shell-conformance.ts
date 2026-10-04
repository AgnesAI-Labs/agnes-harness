import { fileURLToPath, pathToFileURL } from 'node:url'
import { Window } from 'happy-dom'
import { createWorkbenchShell } from '../../../../examples/runtime-reference/src/client/workbench-shell.ts'
import { bindShellContract } from '../../../../examples/runtime-reference/src/providers/shell.ts'
import {
  recoverShell,
  type ShellConformanceBinding,
} from '../../../../packages/extension-api/testkit/runtime/contracts/shell.ts'
import {
  holdUIRegistryClient,
  restartUIRegistryClient,
} from '../../../../packages/extension-api/testkit/runtime/contracts/ui-registry.ts'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'
import { createClientHostRuntime } from '../../../../packages/web-client/src/runtime/client-host.ts'
import { resolveClientSelection } from '../../../../packages/web-client/src/runtime/client-selection.ts'
import { withConformanceBuild } from '../build-identity.js'

const CONTRACT = 'agh.shell'
const REFERENCE = 'reference'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const self = fileURLToPath(import.meta.url)

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
    // The cases' modules read neither, and their registry binds no renderer, so nothing is presented.
    context: {} as HostInput['context'],
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

// Only the reference workbench shell binds here. The web app has no default shell yet, so a default
// request stays without evidence.
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
  if (!request.providers.includes(REFERENCE)) return { contracts: [CONTRACT], providers: [] }
  bindShellContract(withConformanceBuild(harness), request.command, {
    providerId: REFERENCE,
    container,
    select,
    // The client processes run this file, which selects through the same host into the same DOM. The
    // UI registry's client process runner kills the first on READY and waits for the second to exit.
    restart: (directory) => restartUIRegistryClient(['--import', 'tsx', self, directory], root),
  })
  return { contracts: [CONTRACT], providers: [REFERENCE] }
}

// The client process `recover` starts: `<directory>`. The rebuilt one exits once it has recorded what
// it saw, whatever the DOM still holds open.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const directory = process.argv[2]
  if (directory === undefined) throw new Error('expected: <directory>')
  recoverShell({ shell: createWorkbenchShell, container, select }, directory, holdUIRegistryClient).then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'shell client failed'}\n`)
      process.exit(1)
    },
  )
}
