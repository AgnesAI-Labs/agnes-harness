/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ResourcesTab } from '../src/pages/plugins/resources-tab.js'

const controller = vi.hoisted(() => ({
  waitForScope: undefined as Promise<void> | undefined,
  scans: 0,
}))
vi.mock('@agnes/resource-control-web/admin', () => ({
  mountResourceAdmin: () => ({
    ready: Promise.resolve(),
    sync: () => controller.waitForScope ?? Promise.resolve(),
    dispose() {},
    select() {},
    scanSkills: async () => {
      controller.scans++
      return undefined
    },
  }),
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})
it('disables saving and retrying until the current workspace has finished loading', async () => {
  controller.scans = 0
  controller.waitForScope = undefined
  vi.stubGlobal('fetch', async () =>
    Response.json({
      config: {
        rulesEnabled: true,
        timeEnabled: true,
        timeZone: 'UTC',
        refreshIntervalMs: 1000,
        maxBytes: 1000,
        maxSourceBytes: 1000,
        customSkillRoots: ['/preview/skills'],
        instructionFiles: [],
        localInstructionFiles: [],
      },
      workspaces: [],
    }),
  )
  const host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  const render = (workspaceId: string) =>
    act(async () =>
      root?.render(
        createElement(ResourcesTab, {
          tab: 'skills',
          workspaceId,
          canSave: true,
          packageName: () => undefined,
          t: (key) => key,
        }),
      ),
    )
  await render('a'.repeat(64))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false)
  let finish!: () => void
  controller.waitForScope = new Promise<void>((resolve) => {
    finish = resolve
  })
  await render('b'.repeat(64))
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('[data-testid="skill-folders-save"]')?.disabled).toBe(true)
  const retry = host.querySelector<HTMLButtonElement>('[data-testid="skill-scan-retry"]')
  expect(retry?.disabled).toBe(true)
  await act(async () => retry?.click())
  expect(controller.scans).toBe(0)
  await render('a'.repeat(64))
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('[data-testid="skill-scan-retry"]')?.disabled).toBe(true)
  await act(async () => finish())
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false)
  expect(host.querySelector<HTMLButtonElement>('[data-testid="skill-scan-retry"]')?.disabled).toBe(false)
})
