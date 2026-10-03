import { Window } from 'happy-dom'
import { bindShellContract } from '../../../../examples/runtime-reference/src/providers/shell.ts'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'
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

// Only the reference workbench shell binds here. The web app's default shell joins once a client host
// can select and mount it; until then a default request stays without evidence.
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
  bindShellContract(withConformanceBuild(harness), request.command, { providerId: REFERENCE, container })
  return { contracts: [CONTRACT], providers: [REFERENCE] }
}
