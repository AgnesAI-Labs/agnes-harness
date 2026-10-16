/** @vitest-environment happy-dom */
import { installFeedbackSink, type OperationFeedback } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { pluginsPageCatalog } from '../src/pages/plugins/page-locale.js'
import { SkillFolders } from '../src/pages/plugins/skill-folders.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let release: (() => void) | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  release?.()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})
it('keeps field errors local and publishes one save with a persistent rescan consequence and a real action', async () => {
  const results: OperationFeedback[] = []
  release = installFeedbackSink({ publish: (result) => results.push(result), resolve() {} })
  let config = {
    rulesEnabled: true,
    timeEnabled: true,
    timeZone: 'UTC',
    refreshIntervalMs: 1000,
    maxBytes: 1000,
    maxSourceBytes: 1000,
    customSkillRoots: [] as string[],
    instructionFiles: [],
    localInstructionFiles: [],
  }
  const writes: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body))
      if (input.config) {
        config = input.config
        writes.push(input.config)
      }
      return Response.json({ config, workspaces: [] })
    }),
  )
  const onSaved = vi.fn()
  const host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () =>
    root?.render(
      createElement(SkillFolders, { canSave: true, onSaved, t: (key) => pluginsPageCatalog.en[key] ?? key }),
    ),
  )
  const textarea = host.querySelector('textarea')!
  const fill = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
  await fill('relative')
  expect(textarea.getAttribute('aria-invalid')).toBe('true')
  expect(writes).toEqual([])
  await fill('/preview/skills')
  await act(async () => host.querySelector<HTMLElement>('[data-testid="skill-folders-save"]')?.click())
  expect(config.customSkillRoots).toEqual(['/preview/skills'])
  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({
    outcome: 'success',
    scope: 'skill-folders',
    message: 'Skill folders saved.',
    effect: { kind: 'rescan-required' },
  })
  expect(host.querySelector('[data-tone="success"]')).toBeNull()
  expect(onSaved).not.toHaveBeenCalled()
  const effect = results[0]?.effect
  if (effect && 'action' in effect) effect.action?.onSelect()
  expect(onSaved).toHaveBeenCalledOnce()
})
