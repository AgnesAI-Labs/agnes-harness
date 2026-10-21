import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MACHINES } from '../domain.mjs'
import { buildSeed } from '../seed-data.mjs'

// biome-ignore lint/suspicious/noExplicitAny: seed-data.mjs is untyped plain data
type Any = any
const NOW = Date.parse('2026-10-21T08:00:00Z')
const DAY = 86_400_000
const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed-docs')
const seed: Any = buildSeed(NOW)
const ids = (list: Any[]) => new Set(list.map((x) => x.id))
const t = (iso: string) => Date.parse(iso)

const STAGE_ORDER = ['INITIATION', 'REQUIREMENTS', 'DESIGN', 'IMPLEMENTATION', 'VERIFICATION', 'RELEASE']
const STAGE_MOVES: Record<string, string[]> = {
  NOT_STARTED: ['IN_PROGRESS'],
  IN_PROGRESS: ['IN_REVIEW'],
  IN_REVIEW: ['PASSED', 'REWORK'],
  PASSED: ['REWORK'], // an approved CR sends a passed stage back to rework
  REWORK: ['IN_PROGRESS'],
}
const CR_MOVES: Record<string, string[]> = {
  null: ['SUBMITTED'],
  SUBMITTED: ['ANALYZED'],
  ANALYZED: ['CCB_REVIEW'],
  CCB_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: ['IMPLEMENTED'],
  IMPLEMENTED: ['CLOSED'],
}
const DEFECT_MOVES: Record<string, string[]> = {
  null: ['NEW'],
  NEW: ['CONFIRMED'],
  CONFIRMED: ['FIXING', 'DEFERRED'],
  FIXING: ['RETEST'],
  RETEST: ['CLOSED', 'FIXING'],
}

function expectChain(item: Any, moves: Record<string, string[]>, first: string | null) {
  let from = first
  let at = Number.NEGATIVE_INFINITY
  for (const h of item.history) {
    expect(h.from, `${item.id} history`).toBe(from)
    expect(moves[String(from)] ?? [], `${item.id} ${from}→${h.to}`).toContain(h.to)
    expect(t(h.at), `${item.id} history order`).toBeGreaterThanOrEqual(at)
    at = t(h.at)
    from = h.to
  }
  expect(from, `${item.id} state`).toBe(item.state)
}

describe('DevBoard v2 seed data', () => {
  it('has the schema 2 shape with unique ids per collection', () => {
    expect(seed).toMatchObject({ schema: 2, revision: 1 })
    for (const key of [
      'projects',
      'stages',
      'gates',
      'artifacts',
      'reqs',
      'changes',
      'defects',
      'testRuns',
      'requirements',
      'tasks',
      'interventions',
    ]) {
      expect(seed[key].length, key).toBeGreaterThan(0)
      expect(ids(seed[key]).size, `${key} ids`).toBe(seed[key].length)
      // one store key per collection caps near 128 KiB
      expect(JSON.stringify(seed[key]).length, `${key} size`).toBeLessThan(120_000)
    }
    const projectIds = seed.projects.map((p: Any) => p.id)
    expect(projectIds).toEqual(['PRJ-2025-042', 'PRJ-2026-008', 'PRJ-2025-019'])
    for (const p of seed.projects) {
      expect(ids(p.risks).size, `${p.id} risks`).toBe(p.risks.length)
      expect(p.risks.length).toBeGreaterThan(0)
    }
  })

  it('is deterministic and moves every date with now', () => {
    expect(buildSeed(NOW)).toEqual(seed)
    const later: Any = buildSeed(NOW + 7 * DAY)
    let dates = 0
    const walk = (a: Any, b: Any, path: string) => {
      if (typeof a === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(a)) {
        dates += 1
        expect(t(b) - t(a), path).toBe(7 * DAY)
      } else if (a && typeof a === 'object') {
        expect(Object.keys(b), path).toEqual(Object.keys(a))
        for (const k of Object.keys(a)) walk(a[k], b[k], `${path}.${k}`)
      } else expect(b, path).toEqual(a)
    }
    walk(seed, later, 'seed')
    expect(dates).toBeGreaterThan(300)
  })

  it('resolves every trace reference', () => {
    const projects = ids(seed.projects)
    const reqs = new Map(seed.reqs.map((r: Any) => [r.id, r]))
    const artifacts = ids(seed.artifacts)
    const stages = ids(seed.stages)
    for (const key of [
      'stages',
      'artifacts',
      'reqs',
      'changes',
      'defects',
      'testRuns',
      'requirements',
      'tasks',
      'interventions',
    ])
      for (const x of seed[key]) expect(projects.has(x.projectId), `${x.id} projectId`).toBe(true)
    for (const r of seed.reqs) {
      for (const p of r.parent) {
        const parent: Any = reqs.get(p)
        expect(parent, `${r.id} parent ${p}`).toBeDefined()
        expect(parent.projectId).toBe(r.projectId)
      }
      for (const tc of r.verifiedBy) {
        expect((reqs.get(tc) as Any)?.level, `${r.id} verifiedBy ${tc}`).toBe('TC')
        expect((reqs.get(tc) as Any).parent).toContain(r.id)
      }
      if (r.level === 'TC') for (const p of r.parent) expect((reqs.get(p) as Any).verifiedBy).toContain(r.id)
    }
    for (const g of seed.gates) expect(stages.has(g.stageId), g.id).toBe(true)
    for (const s of seed.stages)
      for (const item of s.baseline?.items ?? [])
        expect(artifacts.has(item) || reqs.has(item), `${s.baseline.id} ${item}`).toBe(true)
    for (const a of seed.artifacts) {
      expect(a.source).toEqual({ type: 'seed', docId: a.id })
      expect(stages.has(`${a.projectId}/${a.stage}`), a.id).toBe(true)
    }
    for (const c of seed.changes) {
      for (const id of [...c.impact.reqs, ...c.impact.tests])
        expect(reqs.has(id), `${c.id} impact ${id}`).toBe(true)
      for (const id of c.impact.artifacts) expect(artifacts.has(id), `${c.id} impact ${id}`).toBe(true)
    }
    for (const d of seed.defects) {
      if (d.testCase) expect((reqs.get(d.testCase) as Any)?.level, d.id).toBe('TC')
      if (d.req) expect(reqs.has(d.req), d.id).toBe(true)
    }
    const v1 = (kind: string, id: string) => ids(seed[kind === 'task' ? 'tasks' : 'requirements']).has(id)
    for (const task of seed.tasks) {
      expect(v1('requirement', task.requirementId), task.id).toBe(true)
      for (const dep of task.dependsOn) expect(v1('task', dep), task.id).toBe(true)
    }
    for (const hi of seed.interventions) expect(v1(hi.entity.kind, hi.entity.id), hi.id).toBe(true)
  })

  it('keeps stages, gates and artifacts consistent with the stage and gate rules', () => {
    for (const p of seed.projects) {
      const stages = STAGE_ORDER.map((name) => seed.stages.find((s: Any) => s.id === `${p.id}/${name}`))
      expect(stages.every(Boolean), p.id).toBe(true)
      const firstPassed = stages.map((s: Any) => s.history.find((h: Any) => h.to === 'PASSED')?.at)
      stages.forEach((s: Any, i: number) => {
        expectChain(s, STAGE_MOVES, 'NOT_STARTED')
        // a stage starts only when the previous one is PASSED at that moment
        for (const h of s.history.filter((x: Any) => x.to === 'IN_PROGRESS' && i > 0)) {
          const prev = stages[i - 1].history.filter((x: Any) => t(x.at) <= t(h.at)).at(-1)
          expect(prev?.to, `${s.id} started before ${stages[i - 1].id} passed`).toBe('PASSED')
        }
        if (s.state === 'NOT_STARTED')
          expect(stages.slice(i).every((x: Any) => x.state === 'NOT_STARTED')).toBe(true)
        if (s.state === 'PASSED') expect(s.baseline && s.actualEnd, s.id).toBeTruthy()
        if (firstPassed[i] && i > 0) expect(firstPassed[i - 1], s.id).toBeTruthy()
      })
      expect(p.stage).toBe(stages.findLast((s: Any) => s.state !== 'NOT_STARTED').stage)
    }
    for (const g of seed.gates) {
      const stage = seed.stages.find((s: Any) => s.id === g.stageId)
      expect(g.id.startsWith(`GATE-${stage.projectId}-${stage.stage}-`), g.id).toBe(true)
      expect(g.approverRole, `${g.id} approver is the author`).not.toBe(stage.author)
      expect(ids(g.findings).size).toBe(g.findings.length)
      if (g.decision === 'PENDING') {
        expect(stage.state, g.id).toBe('IN_REVIEW')
        expect(g.decidedAt).toBeUndefined()
      } else {
        expect(g.approver?.startsWith(g.approverRole), g.id).toBe(true)
        const outcome = g.decision === 'APPROVED' ? 'PASSED' : 'REWORK'
        expect(
          stage.history.some((h: Any) => h.to === outcome && h.at === g.decidedAt && h.from === 'IN_REVIEW'),
          g.id,
        ).toBe(true)
      }
      if (g.decision === 'APPROVED')
        expect(
          g.findings.every((f: Any) => f.closed),
          `${g.id} open findings`,
        ).toBe(true)
    }
    for (const s of seed.stages) {
      const reviews = s.history.filter((h: Any) => h.from === 'IN_REVIEW').length
      const decided = seed.gates.filter((g: Any) => g.stageId === s.id && g.decision !== 'PENDING')
      expect(decided.length, `${s.id} gates`).toBe(reviews)
      const pending = seed.gates.filter((g: Any) => g.stageId === s.id && g.decision === 'PENDING')
      expect(pending.length, s.id).toBe(s.state === 'IN_REVIEW' ? 1 : 0)
    }
    for (const a of seed.artifacts) {
      const stage = seed.stages.find((s: Any) => s.id === `${a.projectId}/${a.stage}`)
      if (a.status === 'BASELINED') expect(stage.state, a.id).toBe('PASSED')
      if (a.status === 'IN_REVIEW') expect(stage.state, a.id).toBe('IN_REVIEW')
    }
    // the demo needs a pending gate holding open findings and an overdue unfinished stage
    const held = seed.gates.find((g: Any) => g.id === 'GATE-PRJ-2026-008-DESIGN-1')
    expect(held.decision).toBe('PENDING')
    expect(held.findings.filter((f: Any) => !f.closed)).toHaveLength(2)
    expect(seed.stages.some((s: Any) => s.state === 'IN_PROGRESS' && t(s.plannedEnd) < NOW)).toBe(true)
  })

  it('keeps changes, defects and the v1 collections consistent', () => {
    for (const c of seed.changes) {
      expectChain(c, CR_MOVES, null)
      if (['APPROVED', 'IMPLEMENTED', 'CLOSED'].includes(c.state)) {
        expect(c.ccb?.decision, c.id).toBe('APPROVED')
        // an approved CR sends every affected stage that had already passed back to rework
        for (const artifactId of c.impact.artifacts) {
          const a = seed.artifacts.find((x: Any) => x.id === artifactId)
          const stage = seed.stages.find((s: Any) => s.id === `${a.projectId}/${a.stage}`)
          const before = stage.history.filter((h: Any) => t(h.at) < t(c.ccb.at)).at(-1)
          if (before?.to === 'PASSED')
            expect(
              stage.history.some((h: Any) => h.to === 'REWORK' && h.at === c.ccb.at),
              `${c.id} ${stage.id}`,
            ).toBe(true)
        }
      }
      if (c.state === 'APPROVED')
        for (const id of c.impact.reqs)
          expect(seed.reqs.find((r: Any) => r.id === id).status, id).toBe('CHANGED')
    }
    expect(
      seed.changes
        .filter((c: Any) => c.projectId === 'PRJ-2025-042')
        .map((c: Any) => c.state)
        .sort(),
    ).toEqual(['APPROVED', 'CCB_REVIEW'])
    for (const d of seed.defects) {
      expectChain(d, DEFECT_MOVES, null)
      expect(Boolean(d.closedAt), d.id).toBe(d.state === 'CLOSED')
    }
    for (const kind of ['requirement', 'task', 'intervention'] as const) {
      const list = seed[`${kind}s`]
      for (const item of list) expect(Object.keys(MACHINES[kind]), item.id).toContain(item.state)
    }
    for (const state of Object.keys(MACHINES.task))
      expect(
        seed.tasks.some((x: Any) => x.state === state),
        `task ${state}`,
      ).toBe(true)
    expect(seed.interventions.some((h: Any) => h.state === 'OPEN' && t(h.dueAt) < NOW)).toBe(true)
  })

  it('ships one document per artifact and every id a document cites exists', () => {
    const files = readdirSync(DOCS, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.md'))
      .sort()
    const expected = seed.artifacts.map((a: Any) => join(a.projectId, `${a.source.docId}.md`)).sort()
    expect(files).toEqual(expected)
    expect(files).toHaveLength(15)
    const known = new Set([
      ...seed.reqs.map((r: Any) => r.id),
      ...seed.changes.map((c: Any) => c.id),
      ...seed.defects.map((d: Any) => d.id),
      ...seed.artifacts.map((a: Any) => a.id),
      ...seed.testRuns.map((r: Any) => r.id),
      ...seed.stages.flatMap((s: Any) => (s.baseline ? [s.baseline.id] : [])),
      ...seed.projects.flatMap((p: Any) => [p.id, ...p.risks.map((r: Any) => r.id)]),
    ])
    for (const file of files) {
      const text = readFileSync(join(DOCS, file), 'utf8')
      expect(text, file).toContain('虚构企业与模拟数据')
      const cited =
        text.match(/\b(?:CUS|SYS|SWR|DES|TC|CR|DEF|DOC|TR|BL|PRJ|RSK)-[A-Za-z0-9.-]*[A-Za-z0-9]/g) ?? []
      expect(cited.length, file).toBeGreaterThan(0)
      for (const id of cited) expect(known.has(id), `${file} cites unknown ${id}`).toBe(true)
    }
  })

  it('keeps real companies, lines and customers out of the public repository', () => {
    // Base64 so the denylist itself never matches a repository-wide grep. Case-insensitive.
    const DENY = [
      '5bq35bC8',
      'S2FuZ25p',
      '5Lit6L2m',
      'Q1JSQw==',
      '6Zi/5bCU5pav6YCa',
      'QWxzdG9t',
      'U3RhZGxlcg==',
      '5LiK5rW35Zyw6ZOB',
      '5Y2X5Lqs5Zyw6ZOB',
      '5Y2X5Lqs',
      '5YyX5Lqs5Zyw6ZOB',
      '5bm/5bee5Zyw6ZOB',
      '5q2m5rGJ5Zyw6ZOB',
    ].map((b) => Buffer.from(b, 'base64').toString('utf8').toLowerCase())
    const here = dirname(fileURLToPath(import.meta.url))
    const files = [
      join(here, '..', 'seed-data.mjs'),
      ...readdirSync(DOCS, { recursive: true })
        .map(String)
        .filter((f) => f.endsWith('.md'))
        .map((f) => join(DOCS, f)),
    ]
    for (const file of files) {
      const text = readFileSync(file, 'utf8').toLowerCase()
      for (const word of DENY) expect(text.includes(word), `${file} contains ${word}`).toBe(false)
    }
  })
})
