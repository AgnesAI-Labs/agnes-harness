/** @vitest-environment happy-dom */
import type { RefinementSkillsParams, RefinementSkillsResult } from '@agnes/protocol'
import type { AdminMemoryParams, AdminMemoryResult } from '@agnes/protocol/gen/app-server'
import { createDocumentLocaleSource, UiLocaleProvider } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { type SavedSkillsApi, SavedSkillsBlock } from '../src/settings/refinement-skills.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
const disposers: Array<() => void> = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  for (const dispose of disposers.splice(0)) dispose()
  document.body.replaceChildren()
  document.documentElement.lang = 'en'
})

const REV = (n: number) => String(n).repeat(64)
const HOSTILE = '<img src=x onerror="alert(1)">'

function listed(): RefinementSkillsResult {
  return {
    skills: [
      {
        name: 'lint-fixer',
        resourceId: 'skill/workspace/workspace-agnes/a',
        revision: REV(2),
        state: 'active',
        reviewAfter: Date.UTC(2026, 11, 4),
        initiator: 'auto',
        previous: [REV(1)],
      },
      {
        name: 'deploy-notes',
        resourceId: 'skill/workspace/workspace-agnes/b',
        revision: REV(3),
        state: 'review-disabled',
        reviewAfter: Date.UTC(2026, 9, 4),
        initiator: 'model',
        previous: [],
      },
    ],
    drafts: [
      {
        id: REV(4),
        name: 'release',
        reason: 'changed-since',
        diff: `--- a/SKILL.md\n+++ b/SKILL.md\n+${HOSTILE}\n`,
        at: Date.UTC(2026, 10, 4),
      },
    ],
  }
}

const paragraph = (id: string) => ({ id, text: `Lesson ${id}`, validity: 'valid' as const })
/** The saved list of `admin.memory`: three in the workspace, two in user memory, unless told otherwise. */
const savedLists =
  (counts: { workspace: number; user: number } = { workspace: 3, user: 2 }) =>
  async (input: AdminMemoryParams): Promise<AdminMemoryResult> => {
    const count = input.saved?.layer === 'user' ? counts.user : counts.workspace
    return {
      saved: {
        paragraphs: Array.from({ length: count }, (_, i) => paragraph(`r${String(i).padStart(10, '0')}`)),
      },
    } as unknown as AdminMemoryResult
  }

function fakeApi(result: RefinementSkillsResult = listed()) {
  const skills = vi.fn(async (_input: RefinementSkillsParams) => structuredClone(result))
  const memory = vi.fn(savedLists())
  const api: SavedSkillsApi = {
    workspaces: vi.fn(async () => [
      { path: '/gone', available: false },
      { path: '/work/repo', available: true },
    ]),
    skills,
    memory,
  }
  return { api, skills, memory }
}

async function mount(api: SavedSkillsApi) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  const locale = createDocumentLocaleSource({})
  disposers.push(locale.dispose)
  await act(async () =>
    root.render(
      createElement(UiLocaleProvider, { source: locale.source }, createElement(SavedSkillsBlock, { api })),
    ),
  )
  await act(async () => {})
  await act(async () => {})
  return host
}
const all = (host: HTMLElement, testid: string) => [
  ...host.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`),
]

it('lists the saved skills of the first available workspace, with their state and who saved them', async () => {
  const { api, skills } = await Promise.resolve(fakeApi())
  const host = await mount(api)
  expect(skills).toHaveBeenCalledWith({ cwd: '/work/repo', action: 'list' })
  const rows = all(host, 'refinement-saved-skill')
  expect(rows).toHaveLength(2)
  expect(rows[0]?.textContent).toContain('lint-fixer')
  expect(rows[0]?.textContent).toMatch(/On, review due/)
  expect(rows[0]?.textContent).toContain('automatically')
  expect(rows[1]?.textContent).toMatch(/Awaiting review/)
  expect(rows[1]?.textContent).toContain('the model')
  // Only a skill with an earlier version can be rolled back.
  const rollbacks = all(host, 'refinement-saved-skill-rollback') as HTMLButtonElement[]
  expect(rollbacks.map((button) => button.disabled)).toEqual([false, true])
})

it('says when a skill was turned off because the workspace reached its limit', async () => {
  const base = listed()
  const [first, second] = base.skills as [
    RefinementSkillsResult['skills'][number],
    RefinementSkillsResult['skills'][number],
  ]
  const { api } = fakeApi({ ...base, skills: [first, { ...second, disabledFor: 'capacity' }] })
  const host = await mount(api)
  const rows = all(host, 'refinement-saved-skill')
  expect(rows[1]?.textContent).toContain('Turned off: workspace limit of 20')
  expect(rows[1]?.textContent).not.toMatch(/Awaiting review/)
  expect(rows[0]?.textContent).not.toContain('limit')
})

it('shows how much task experience is saved for the chosen workspace, and in user memory', async () => {
  const { api, memory } = fakeApi()
  const host = await mount(api)
  expect(memory).toHaveBeenCalledWith({ cwd: '/work/repo', saved: { action: 'list' } })
  expect(memory).toHaveBeenCalledWith({ cwd: '/work/repo', saved: { action: 'list', layer: 'user' } })
  const counts = all(host, 'refinement-saved-counts')
  expect(counts).toHaveLength(1)
  expect(counts[0]?.textContent).toContain('Saved experience: 5 (workspace 3, user 2)')
})

it('shows no count when the saved lists cannot be read', async () => {
  const { api } = fakeApi()
  const host = await mount({
    ...api,
    memory: async () => {
      throw new Error('memory unavailable')
    },
  })
  expect(all(host, 'refinement-saved-counts')).toHaveLength(0)
  expect(all(host, 'refinement-saved-skill')).toHaveLength(2)
})

it('marks a saved skill made from a finished workflow run, and no other', async () => {
  const base = listed()
  const [first, second] = base.skills as [
    RefinementSkillsResult['skills'][number],
    RefinementSkillsResult['skills'][number],
  ]
  const { api } = fakeApi({ ...base, skills: [{ ...first, workflow: true }, second] })
  const host = await mount(api)
  const rows = all(host, 'refinement-saved-skill')
  expect(rows[0]?.textContent).toContain('Made from a finished workflow run')
  expect(rows[1]?.textContent).not.toContain('workflow')
})

it('uninstalls or rolls back a saved skill for the owner and shows the list it answers with', async () => {
  const { api, skills } = fakeApi()
  const host = await mount(api)
  skills.mockResolvedValueOnce({
    ...listed(),
    skills: [
      { ...(listed().skills[0] as RefinementSkillsResult['skills'][number]), revision: REV(1), previous: [] },
    ],
  })
  await act(async () => (all(host, 'refinement-saved-skill-rollback')[0] as HTMLButtonElement).click())
  expect(skills).toHaveBeenLastCalledWith({ cwd: '/work/repo', action: 'rollback', name: 'lint-fixer' })
  expect(all(host, 'refinement-saved-skill')).toHaveLength(1)
  skills.mockResolvedValueOnce({ skills: [], drafts: [] })
  await act(async () => (all(host, 'refinement-saved-skill-uninstall')[0] as HTMLButtonElement).click())
  expect(skills).toHaveBeenLastCalledWith({ cwd: '/work/repo', action: 'uninstall', name: 'lint-fixer' })
  expect(all(host, 'refinement-saved-skill')).toHaveLength(0)
})

it('shows the drafts kept for a person as plain text, never as markup', async () => {
  const { api } = fakeApi()
  const host = await mount(api)
  const [draft] = all(host, 'refinement-skill-draft')
  expect(draft?.textContent).toContain('release')
  expect(draft?.textContent).toMatch(/changed it/)
  expect(draft?.textContent).toContain(HOSTILE)
  expect(host.querySelector('img')).toBeNull()
})

it('says so when the request fails, and shows nothing when nothing is saved', async () => {
  const failing: SavedSkillsApi = {
    workspaces: async () => [{ path: '/w', available: true }],
    memory: savedLists(),
    skills: async () => {
      throw Object.assign(new Error('x'), {
        data: { code: 'SEMANTIC_REJECTED', reason: 'SKILL_CHANGED_SINCE' },
      })
    },
  }
  const host = await mount(failing)
  expect(all(host, 'refinement-saved-skills-error')).toHaveLength(1)
  const empty = await mount(fakeApi({ skills: [], drafts: [] }).api)
  expect(empty.querySelector('[data-testid="refinement-saved-skills"]')?.textContent).toMatch(/No skills/)
})

it('shows the section in Chinese', async () => {
  document.documentElement.lang = 'zh-CN'
  const base = listed()
  const [first, second] = base.skills as [
    RefinementSkillsResult['skills'][number],
    RefinementSkillsResult['skills'][number],
  ]
  const host = await mount(
    fakeApi({ ...base, skills: [first, second, { ...second, name: 'over', disabledFor: 'capacity' }] }).api,
  )
  expect(host.textContent).toContain('待复核')
  expect(host.textContent).toContain('回滚到上一版')
  expect(host.textContent).toContain('因数量上限停用')
  expect(host.textContent).toContain('已存经验 5 条（工作区 3，用户 2）')
})
