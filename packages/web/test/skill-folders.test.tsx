/** @vitest-environment happy-dom */
import { createHash, webcrypto } from 'node:crypto'
import type { SkillScanReport } from '@agnes/protocol'
import { installFeedbackSink, type OperationFeedback } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { pluginsPageCatalog } from '../src/pages/plugins/page-locale.js'
import { SkillFolders } from '../src/pages/plugins/skill-folders.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let release: (() => void) | undefined
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture value.')
  return value
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const report = (roots: string[]): SkillScanReport => ({
  operationId: 'scan-1',
  generation: 1,
  observedAt: '2026-10-29T08:00:00.000Z',
  configurationRevision: hash(JSON.stringify(roots)),
  complete: false,
  foundCount: 2,
  skippedCount: 1,
  unreadableDirectoryCount: 1,
  truncated: false,
  directories: roots.map((path, i) => ({
    directoryId: hash(path),
    rootKey: 'user-agnes',
    state: i === 0 ? 'partial' : 'unavailable',
    complete: false,
    foundCount: i === 0 ? 2 : 0,
    skippedCount: i === 0 ? 1 : 0,
    unreadable: i !== 0,
    truncated: false,
    issues:
      i === 0
        ? [{ code: 'invalid-frontmatter', stage: 'parse' }]
        : [{ code: 'permission-denied', stage: 'list', osCode: 'EPERM' }],
  })),
})
async function mount(
  options: {
    roots?: string[]
    scan?: () => Promise<SkillScanReport | undefined>
    locale?: 'en' | 'zh-CN'
    canSave?: boolean
  } = {},
) {
  const results: OperationFeedback[] = []
  release = installFeedbackSink({ publish: (result) => results.push(result), resolve() {} })
  let config = {
    rulesEnabled: true,
    timeEnabled: true,
    timeZone: 'UTC',
    refreshIntervalMs: 1000,
    maxBytes: 1000,
    maxSourceBytes: 1000,
    customSkillRoots: options.roots ?? [],
    instructionFiles: [],
    localInstructionFiles: [],
  }
  const writes: unknown[] = []
  vi.stubGlobal('crypto', webcrypto)
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
  const host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  const scan = options.scan ?? (async () => undefined)
  await act(async () =>
    root?.render(
      createElement(SkillFolders, {
        canSave: options.canSave ?? true,
        onSaved: scan,
        t: (key, vars) =>
          Object.entries(vars ?? {}).reduce(
            (text, [name, value]) => text.replace(`{${name}}`, String(value)),
            pluginsPageCatalog[options.locale ?? 'en'][key] ?? key,
          ),
      }),
    ),
  )
  const fill = async (value: string) =>
    act(async () => {
      const textarea = required(host.querySelector('textarea'))
      required(Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set).call(
        textarea,
        value,
      )
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
  const save = () =>
    act(async () => host.querySelector<HTMLElement>('[data-testid="skill-folders-save"]')?.click())
  return { host, results, writes, fill, save, config: () => config }
}
afterEach(async () => {
  await act(async () => root?.unmount())
  release?.()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('automatically scans after saving and keeps the saving result separate while the scan is pending', async () => {
  let finish!: (value: SkillScanReport | undefined) => void
  let scans = 0
  const view = await mount({
    scan: () => {
      scans++
      return new Promise((resolve) => {
        finish = resolve
      })
    },
  })
  await view.fill('relative')
  expect(view.host.querySelector('textarea')?.getAttribute('aria-invalid')).toBe('true')
  expect(view.writes).toEqual([])
  await view.fill('/preview/skills')
  await view.save()
  expect(scans).toBe(1)
  expect(view.config().customSkillRoots).toEqual(['/preview/skills'])
  expect(view.results).toMatchObject([
    { outcome: 'success', message: 'Skill folders saved. Checking the folders…' },
  ])
  expect(view.host.textContent).toContain('Scanning folders…')
  expect(view.host.textContent).not.toContain('Found 0')
  expect(view.host.querySelector<HTMLButtonElement>('[data-testid="skill-folders-save"]')?.disabled).toBe(
    true,
  )
  await act(async () => finish(undefined))
  expect(view.host.textContent).toContain('Scan details were not returned')
})

it.each(['en', 'zh-CN'] as const)(
  'shows per-folder partial results and copies only safe diagnostic fields (%s)',
  async (locale) => {
    const roots = ['/preview/skills', '/private/Downloads/team']
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          copied = value
        },
      },
    })
    const view = await mount({
      locale,
      scan: async () =>
        ({ ...report(roots), path: '/secret/leak', message: 'private detail' }) as SkillScanReport,
    })
    await view.fill(roots.join('\n'))
    await view.save()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(view.host.textContent).toContain(roots[0])
    expect(view.host.textContent).toContain(roots[1])
    expect(view.host.textContent).toContain(locale === 'en' ? 'Access denied' : '访问被拒绝')
    expect(view.host.textContent).toContain(
      locale === 'en' ? 'Found 2 valid skill files' : '发现 2 项有效技能文件',
    )
    expect(view.host.textContent).toContain(
      locale === 'en' ? 'The number of files in this folder is unknown' : '此目录内的文件数量未知',
    )
    const copy = required(view.host.querySelector<HTMLButtonElement>('[data-testid="skill-scan-copy"]'))
    await act(async () => copy.click())
    expect(copied).toContain('scan-1')
    expect(copied).toContain('EPERM')
    expect(copied).not.toContain('/preview')
    expect(copied).not.toContain('/private')
    expect(copied).not.toContain('/secret')
    expect(copied).not.toContain('private detail')
  },
)

it('does not label newly saved folders with a report for another configuration', async () => {
  const view = await mount({ scan: async () => report(['/old/skills']) })
  await view.fill('/new/skills')
  await view.save()
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  expect(view.host.textContent).not.toContain('Found 2')
  expect(view.host.textContent).toContain('The folder configuration changed')
})

it('keeps a saved configuration after scan failure and retries only the scan', async () => {
  let scans = 0
  const view = await mount({
    scan: async () => {
      scans++
      if (scans === 1) throw new Error('private detail')
      return undefined
    },
  })
  await view.fill('/preview/skills')
  await view.save()
  expect(view.host.textContent).toContain('The folders were saved, but the scan did not finish')
  expect(view.host.textContent).not.toContain('private detail')
  const retry = required(view.host.querySelector<HTMLButtonElement>('[data-testid="skill-scan-retry"]'))
  await act(async () => retry.click())
  expect(scans).toBe(2)
  expect(view.writes).toHaveLength(1)
})

it('labels truncated counts as observations and never as added or enabled skills', async () => {
  const roots = ['/preview/skills']
  const value = report(roots)
  value.truncated = true
  required(value.directories[0]).issues = [{ code: 'entry-limit', stage: 'budget' }]
  const view = await mount({ scan: async () => value })
  await view.fill('/preview/skills')
  await view.save()
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  expect(view.host.textContent).toContain('may be lower bounds')
  expect(view.host.textContent).toContain('not a count of new or enabled skills')
  expect(view.host.textContent).toContain('Some files were not checked')
})

it('reports cancellation separately from a saved configuration and keeps retry available', async () => {
  const view = await mount({
    scan: async () => {
      throw Object.assign(new Error('cancelled'), { code: 'SKILL_SCAN_CANCELLED' })
    },
  })
  await view.fill('/preview/skills')
  await view.save()
  expect(view.host.textContent).toContain('The scan was cancelled')
  expect(view.writes).toHaveLength(1)
  expect(view.host.querySelector<HTMLButtonElement>('[data-testid="skill-scan-retry"]')?.disabled).toBe(false)
})

it('does not start a scan or publish a save result when a delayed save returns after leaving', async () => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  let scans = 0
  const view = await mount({
    scan: async () => {
      scans++
      return undefined
    },
  })
  const originalFetch = fetch
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    await pending
    return originalFetch(input, init)
  })
  await view.fill('/preview/skills')
  await view.save()
  await act(async () => root?.unmount())
  root = undefined
  await act(async () => finish())
  expect(scans).toBe(0)
  expect(view.results).toEqual([])
})

it.each(['en', 'zh-CN'] as const)(
  'explains that save and scan enables newly discovered skills (%s)',
  async (locale) => {
    const view = await mount({ locale })
    const help = view.host.querySelector('[data-testid="skill-folders-scan-effect"]')
    expect(help?.textContent).toContain(
      locale === 'en' ? 'Newly discovered skills will be enabled.' : '新发现的技能会启用。',
    )
    expect(
      view.host.querySelector('[data-testid="skill-folders-save"]')?.getAttribute('aria-describedby'),
    ).toBe(help?.id)
  },
)

it('keeps a returned report pending while its folder hashes are still being checked', async () => {
  const roots = ['/preview/skills']
  const view = await mount({ scan: async () => report(roots) })
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  vi.stubGlobal('crypto', {
    subtle: {
      digest: async (...args: Parameters<typeof webcrypto.subtle.digest>) => {
        await pending
        return webcrypto.subtle.digest(...args)
      },
    },
  })
  await view.fill('/preview/skills')
  await view.save()
  expect(view.host.textContent).toContain('Scanning folders…')
  expect(view.host.textContent).not.toContain('Scan details were not returned')
  await act(async () => finish())
})
