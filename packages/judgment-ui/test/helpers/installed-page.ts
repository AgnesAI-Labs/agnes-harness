import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ClientProfileCaller, ModuleIdentity } from '@agnes/web-client'
import { revokeContributionOwner, settingsSections } from '@agnes/web-client'
import { createClientPanelTestHost, React } from '@agnes/web-client/testkit'
import { createRoot } from 'react-dom/client'
import { afterAll } from 'vitest'

const directories = new Set<string>()
afterAll(async () => {
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })))
})

/** Load unchanged installed bytes where the public browser peers resolve, as the Web test host does. */
export async function installedJudgmentPage(
  source: string,
  identity: ModuleIdentity,
  caller: ClientProfileCaller,
) {
  const directory = await mkdtemp(resolve(__dirname, '../.bundled-ui-test-'))
  directories.add(directory)
  const entry = join(directory, 'client.js')
  await writeFile(entry, source)
  const module = await import(/* @vite-ignore */ pathToFileURL(entry).href)
  let finishRead!: () => void
  const firstRead = new Promise<void>((resolve) => {
    finishRead = resolve
  })
  const host = await createClientPanelTestHost(
    module,
    identity,
    async (...args) => {
      try {
        return await caller(...args)
      } finally {
        finishRead()
      }
    },
    'zh-CN',
  )
  const element = host.window.document.createElement('div')
  host.container.append(element)
  const container = element as unknown as HTMLDivElement
  const root = createRoot(container)
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const name of ['location', 'history'] as const) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { value: host.window[name], configurable: true })
  }
  const dispose = async () => {
    await host.act(async () => root.unmount())
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
    directories.delete(directory)
    for (const [name, value] of saved) {
      if (value) Object.defineProperty(globalThis, name, value)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
  try {
    const section = settingsSections.get('judgment')
    if (!section) throw new Error('installed judgment page not registered')
    await host.act(async () =>
      root.render(React.createElement(section.component, { context: { t: (key) => key } })),
    )
    await host.act(async () => {
      await firstRead
    })
  } catch (error) {
    await dispose()
    throw error
  }
  return {
    text: () => container.textContent ?? '',
    async withdraw() {
      await host.act(async () => revokeContributionOwner(identity.rowId ?? identity.packageId))
      if (settingsSections.get('judgment')) throw new Error('withdrawn judgment settings retained')
    },
    dispose,
  }
}
