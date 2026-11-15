// @vitest-environment happy-dom
// The panel on a fresh install: answered by Superagent's real service, which waits for the repository, the Source page
// lists GitHub and its settings card offers the repository field, so the owner can complete the setup there.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createHookStateHolder } from '../../superagent/src/runtime/hook-state.js'
import { type SuperagentService, startService } from '../../superagent/src/runtime/index.js'
import { App } from '../src/app.js'
import { zh } from '../src/locales.js'
import { all, translator } from './helpers/panel.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Starts the managed service on an empty state directory, with a grant over a client that opens no session. */
async function freshService(): Promise<SuperagentService> {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'superagent-first-panel-'))
  const shutdowns: ((reason: 'disable') => Promise<unknown>)[] = []
  cleanups.push(() => rmSync(stateDirectory, { recursive: true, force: true }))
  const refused = async () => {
    throw new Error('no session in this test')
  }
  const init = {
    bundledApp: {
      stateDirectory,
      client: {
        initialize: async () => {},
        close: async () => {},
        clientId: async () => 'superagent',
        call: refused,
        session: { list: refused, load: refused },
      },
      channels: { subscribe: () => () => {} },
      assertCurrent: () => {},
    },
    onShutdown: (handler: (typeof shutdowns)[number]) => shutdowns.push(handler),
    ready: () => {},
  } as unknown as Parameters<typeof startService>[0]
  const service = await startService(init, createHookStateHolder(), { warn: () => {} })
  cleanups.push(async () => {
    for (const shutdown of shutdowns) await shutdown('disable')
  })
  return service
}

async function mount(service: SuperagentService) {
  const signal = new AbortController().signal
  const services = {
    query: (name: string, input: Record<string, unknown>) => service.callService(name, input, signal),
    effect: async (name: string, input: Record<string, unknown>, options: { operationId: string }) => ({
      state: 'completed',
      operationId: options.operationId,
      output: await service.callService(name, input, signal),
    }),
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  cleanups.push(() => {
    act(() => root.unmount())
    container.remove()
  })
  await act(async () => {
    root.render(<App t={translator(zh)} openSession={async () => {}} services={services} />)
  })
}
const press = async (name: string) => {
  const target = all('button, [role="tab"], a').find((element) => element.textContent?.trim() === name)
  if (!target) throw new Error(`No control named ${name}`)
  await act(async () => {
    target.click()
  })
}

it('shows the GitHub Source on a fresh install and opens its repository field from the setup problem', async () => {
  sessionStorage.clear()
  const service = await freshService()
  await vi.waitFor(async () =>
    expect(await service.callService('superagent.state', {}, new AbortController().signal)).toMatchObject({
      setup: { problem: { code: 'repositoryUnset' } },
    }),
  )
  await mount(service)
  await press(zh['tab.source'])
  await vi.waitFor(() =>
    expect(all('.dt-form > .dt-list > .dt-row .dt-row-name').map((title) => title.textContent)).toContain(
      'GitHub',
    ),
  )
  await press(zh.sourceOpenSettings)
  await vi.waitFor(() => {
    const github = all('.dt-card').find((card) => card.textContent?.includes('GitHub'))
    expect(github?.textContent).toContain('监听的仓库')
    expect(github?.querySelector('input')).not.toBeNull()
  })
})
