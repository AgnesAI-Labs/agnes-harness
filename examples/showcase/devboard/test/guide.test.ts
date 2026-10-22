import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MAIN_STEPS, ROLE_STEPS } from '../client/guide-data.js'
import { createGuideMemory } from '../client/guide-memory.js'
import { liveProject, mainProgress } from '../client/guide-progress.js'
import { GATE_PROFILES, ROLES } from '../profiles.mjs'
import { buildSeed } from '../seed-data.mjs'

// biome-ignore lint/suspicious/noExplicitAny: guide data and snapshots are untyped plain data
type Any = any
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'client/agnes.client.json'), 'utf8'))
const homeEntries: string[] = manifest.client.homeEntries.map((e: Any) => e.id)
const roleSteps = ROLE_STEPS as Record<string, Any[]>
const projectIds: string[] = buildSeed(Date.now()).projects.map((p: Any) => p.id)
const allSteps: Any[] = [...MAIN_STEPS, ...Object.values(roleSteps).flat()]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(path)
    return /\.(m?js|ts|json|md|css)$/.test(e.name) ? [path] : []
  })
}

describe('demo guide data', () => {
  it('covers every demo role with 4 to 6 steps', () => {
    expect(Object.keys(roleSteps).sort()).toEqual([...ROLES].sort())
    for (const role of ROLES) {
      expect(roleSteps[role].length, role).toBeGreaterThanOrEqual(4)
      expect(roleSteps[role].length, role).toBeLessThanOrEqual(6)
    }
  })

  it('gives every step the full copy, a unique id and an existing page', () => {
    expect(new Set(allSteps.map((s) => s.id)).size).toBe(allSteps.length)
    for (const step of allSteps) {
      for (const field of ['id', 'title', 'page', 'how', 'see', 'value'])
        expect(step[field], `${step.id}.${field}`).toEqual(expect.any(String))
      expect(homeEntries, step.id).toContain(step.page)
      if (step.project) expect(['live', ...projectIds], step.id).toContain(step.project)
      if (!step.action) expect(step.spot, `${step.id}.spot`).toEqual(expect.any(String))
    }
  })

  it('points every target at an element the pages mark with data-guide', () => {
    const pages = readdirSync(join(ROOT, 'client'))
      .filter((f) => f.endsWith('.js') && !f.startsWith('guide'))
      .map((f) => readFileSync(join(ROOT, 'client', f), 'utf8'))
      .join('\n')
    const targets = new Set(allSteps.flatMap((s) => [s.target ?? []].flat()))
    expect(targets.size).toBeGreaterThan(10)
    // Pages mark elements as `'data-guide': 'id'` or through the `guided('id', node)` wrapper.
    for (const id of targets) expect(pages, id).toMatch(new RegExp(`['"]${id}['"]`))
  })

  it('walks the 12-step main line through the live software gates', () => {
    expect(MAIN_STEPS).toHaveLength(12)
    const gates = Object.values(GATE_PROFILES.SOFTWARE as Record<string, Any>).flatMap((s) => s.gates)
    for (const step of MAIN_STEPS) {
      expect(ROLES, step.id).toContain(step.role)
      const [code, state] = String(step.done ?? '').split(':')
      const gate = gates.find((g) => g.code === code)
      if (state === 'approved' && !gate.auto) expect(gate.approverRoles, step.id).toContain(step.role)
    }
    expect(MAIN_STEPS.find((s) => 'action' in s)?.action).toBe('new-project')
  })

  it('sends step 7 to the live project tasks and step 12 to the delivery card, and step 2 mentions fast-forward', () => {
    const step = (id: string) => MAIN_STEPS.find((s) => s.id === id) as Any
    expect(step('m7')).toMatchObject({ page: 'devboard-tasks', project: 'live', target: 'tasks-view' })
    expect(step('m12')).toMatchObject({
      page: 'devboard-projects',
      project: 'live',
      target: 'projects-delivery',
    })
    expect(step('m2').note).toContain('快进演示到…')
    // the start button only drafts a request; the presenter sends it and approves a shell command
    expect(step('m12').how).toContain('批准其中一条 shell 命令')
    expect(step('m12').note).toContain('macOS 沙箱')
    // the main steps keep their board rules: the card only changes where step 12 points
    expect(MAIN_STEPS.map((s) => s.done)).toEqual([
      undefined,
      'project',
      'CDCP:submitted',
      'CDCP:approved',
      'TR1:submitted',
      'TR1:approved',
      'TR3:submitted',
      'TR3:approved',
      'TR4:approved',
      'TR5:submitted',
      'TR5:approved',
      'ADCP:approved',
    ])
  })

  it('ends the guide of each main-line role with a pointer to its main-line steps', () => {
    for (const role of new Set(MAIN_STEPS.map((s) => s.role))) {
      const mine = MAIN_STEPS.flatMap((s, i) => (s.role === role ? [i + 1] : []))
      expect(roleSteps[role].at(-1)?.main, role).toEqual(mine)
      expect(
        roleSteps[role].filter((s) => s.main),
        role,
      ).toHaveLength(1)
    }
  })

  it('names only the fictional company', () => {
    // Real company names must not appear in this public repository, so only their hashes are kept
    // here: sha256 prefix by name length, matched against every substring of that length.
    const forbidden: Record<number, string[]> = {
      2: ['0876ac236f2cdc80', '10035b1808607f91'],
      3: ['3b7356188745b0f8', 'fbfcb0b058521d11', 'b61c7d641d8875bb'],
      5: ['d45437499c5035f5', 'c1405e603d5e3c56'],
      8: ['256bae985b56e8ea'],
    }
    const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
    const hits: string[] = []
    // the shipped sample project is scanned as well
    expect(sourceFiles(ROOT).filter((f) => f.includes('/assets/fastforward/')).length).toBeGreaterThan(10)
    for (const file of sourceFiles(ROOT)) {
      const text = readFileSync(file, 'utf8')
      for (const [len, hashes] of Object.entries(forbidden)) {
        for (let i = 0; i + Number(len) <= text.length; i++) {
          if (hashes.includes(hash(text.slice(i, i + Number(len))))) hits.push(`${relative(ROOT, file)}:${i}`)
        }
      }
    }
    expect(hits).toEqual([])
  })
})

describe('main-line progress from the board snapshot', () => {
  const LIVE = 'PRJ-2026-030'
  const gate = (projectId: string, code: string, decision = 'PENDING') => ({
    id: `GATE-${projectId}-${code}-1`,
    stageId: `${projectId}/STAGE`,
    code,
    decision,
  })
  const done = (data: Any) => Object.keys(mainProgress(data, MAIN_STEPS))
  const live = { id: LIVE, live: true, workspaceDir: `devboard-projects/${LIVE}` }
  const board = (...gates: Any[]) => ({ projects: [{ id: 'PRJ-2025-019' }, live], gates })

  it('ticks nothing for the preset projects and ignores their gates', () => {
    const data = { projects: [{ id: 'PRJ-2025-019' }], gates: [gate('PRJ-2025-019', 'CDCP', 'APPROVED')] }
    expect(liveProject(data)).toBeUndefined()
    expect(done(data)).toEqual([])
    expect(done({})).toEqual([])
  })

  it('ticks the project, then every gate it submits and approves', () => {
    expect(done(board())).toEqual(['m2'])
    expect(done(board(gate(LIVE, 'CDCP')))).toEqual(['m2', 'm3'])
    expect(done(board(gate(LIVE, 'CDCP', 'REJECTED')))).toEqual(['m2', 'm3'])
    expect(done(board(gate(LIVE, 'CDCP', 'APPROVED'), gate(LIVE, 'TR1')))).toEqual(['m2', 'm3', 'm4', 'm5'])
    const all = ['CDCP', 'TR1', 'TR3', 'TR4', 'TR5', 'ADCP'].map((c) => gate(LIVE, c, 'APPROVED'))
    expect(done(board(...all))).toEqual(MAIN_STEPS.filter((s) => s.id !== 'm1').map((s) => s.id))
  })
})

describe('what the guide remembers in the browser', () => {
  const fakeStorage = () => {
    const rows = new Map<string, string>()
    return {
      rows,
      getItem: (k: string) => rows.get(k) ?? null,
      setItem: (k: string, v: string) => void rows.set(k, v),
    }
  }

  it('opens by itself once per role, unless switched off, and restarts from the beginning', () => {
    const storage = fakeStorage()
    const memory = createGuideMemory(() => storage)
    expect(memory.shouldAutoOpen('项目经理')).toBe(true)
    memory.markSeen('项目经理')
    expect(memory.shouldAutoOpen('项目经理')).toBe(false)
    expect(memory.shouldAutoOpen('IPMT')).toBe(true)
    memory.setAutoOpenOff(true)
    expect(memory.shouldAutoOpen('IPMT')).toBe(false)
    // A reload (a new memory over the same storage) sees the same state.
    expect(createGuideMemory(() => storage).seen('项目经理')).toBe(true)

    memory.setTick(true, '项目经理', 'm1', true)
    memory.setTick(false, '项目经理', 'pm-1', true)
    memory.setTick(false, 'IPMT', 'ipmt-1', true)
    expect([...memory.ticks(true, 'IPMT')]).toEqual(['m1'])
    expect([...memory.ticks(false, '项目经理')]).toEqual(['pm-1'])
    memory.setTick(false, '项目经理', 'pm-1', false)
    expect(memory.ticks(false, '项目经理').size).toBe(0)
    memory.setTick(false, '项目经理', 'pm-1', true)
    memory.restart('项目经理')
    expect(memory.ticks(true, 'IPMT').size).toBe(0)
    expect(memory.ticks(false, '项目经理').size).toBe(0)
    expect(memory.seen('项目经理')).toBe(true)
    expect([...memory.ticks(false, 'IPMT')]).toEqual(['ipmt-1'])
  })

  it('keeps working in memory when the browser blocks storage', () => {
    const memory = createGuideMemory(() => {
      throw new Error('blocked')
    })
    memory.markSeen('质量工程师')
    memory.setTick(false, '质量工程师', 'qe-1', true)
    expect(memory.seen('质量工程师')).toBe(true)
    expect([...memory.ticks(false, '质量工程师')]).toEqual(['qe-1'])
  })
})
