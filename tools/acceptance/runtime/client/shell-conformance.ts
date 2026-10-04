import { Window } from 'happy-dom'
import { bindShellContract } from '../../../../examples/runtime-reference/src/providers/shell.ts'
import type { ShellConformanceBinding } from '../../../../packages/extension-api/testkit/runtime/contracts/shell.ts'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'
import { createClientHostRuntime } from '../../../../packages/web-client/src/runtime/client-host.ts'
import { resolveClientSelection } from '../../../../packages/web-client/src/runtime/client-selection.ts'
import { withConformanceBuild } from '../build-identity.js'

const CONTRACT = 'agh.shell'
const REFERENCE = 'reference'

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
  })
  return { contracts: [CONTRACT], providers: [REFERENCE] }
}
