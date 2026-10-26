import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isOverdue } from '../approvals.mjs'
import { GATE_PROFILES, ORGS, ROLES } from '../profiles.mjs'
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
  // IN_PROGRESS again: a gate other than the last one of the stage was approved
  IN_REVIEW: ['PASSED', 'REWORK', 'IN_PROGRESS'],
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
const TRIAL_MOVES: Record<string, string[]> = {
  null: ['PLANNED'],
  PLANNED: ['IN_PROGRESS'],
  IN_PROGRESS: ['REPORTED'],
  REPORTED: ['APPROVED', 'IN_PROGRESS'],
}
const FAULT_MOVES: Record<string, string[]> = {
  null: ['NEW'],
  NEW: ['DISPATCHED'],
  DISPATCHED: ['HANDLED'],
  HANDLED: ['CLOSED'],
}
const PROBLEM_MOVES: Record<string, string[]> = {
  null: ['OPEN'],
  OPEN: ['ANALYZING'],
  ANALYZING: ['ACTION'],
  ACTION: ['VERIFYING'],
  VERIFYING: ['CLOSED'],
}
// v1 collection states (kept local so this test does not load the domain module)
const V1_STATES: Record<string, string[]> = {
  requirement: ['RAW', 'REFINED', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED'],
  task: ['PENDING', 'IN_PROGRESS', 'BLOCKED', 'FAILED', 'COMPLETED', 'CANCELLED'],
  intervention: ['OPEN', 'EXPIRED', 'CLAIMED', 'RESOLVED'],
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

const project = (id: string) => seed.projects.find((p: Any) => p.id === id)
const profileOf = (projectId: string): Any =>
  GATE_PROFILES[project(projectId).kind as keyof typeof GATE_PROFILES]
const gateCodes = (projectId: string, stage: string): string[] => {
  const skipped: string[] = project(projectId).tailoring?.skipped ?? []
  return profileOf(projectId)
    [stage].gates.map((g: Any) => g.code as string)
    .filter((c: string) => !skipped.includes(c))
}
// "<role> <name>" strings; CCB and the PHM platform are the only non-person actors
const isPerson = (by: string) => ROLES.some((r) => by.startsWith(`${r} `))
const isActor = (by: string) => isPerson(by) || by === 'CCB' || by === 'PHM 平台'

describe('DevBoard v3 seed data', () => {
  it('has the schema 4 shape with unique ids per collection', () => {
    expect(seed).toMatchObject({ schema: 4, revision: 1 })
    for (const key of [
      'projects',
      'stages',
      'gates',
      'artifacts',
      'reqs',
      'changes',
      'defects',
      'testRuns',
      'trials',
      'faults',
      'problems',
      'items',
      'configBaselines',
      'approvals',
      'requirements',
      'tasks',
      'interventions',
    ]) {
      expect(seed[key].length, key).toBeGreaterThan(0)
      expect(ids(seed[key]).size, `${key} ids`).toBe(seed[key].length)
      // one store key per collection caps near 128 KiB
      expect(JSON.stringify(seed[key]).length, `${key} size`).toBeLessThan(120_000)
    }
    expect(seed.projects.map((p: Any) => p.id)).toEqual([
      'PRJ-2025-042',
      'PRJ-2026-008',
      'PRJ-2025-019',
      'PRJ-2023-011',
    ])
    expect(seed.projects.map((p: Any) => p.kind)).toEqual(['NEW_BUILD', 'RETROFIT', 'SOFTWARE', 'NEW_BUILD'])
    for (const p of seed.projects) {
      expect(ids(p.risks).size, `${p.id} risks`).toBe(p.risks.length)
      expect(p.risks.length).toBeGreaterThan(0)
      expect(ORGS, `${p.id} org`).toContain(p.org)
      for (const code of p.tailoring?.skipped ?? [])
        expect(
          STAGE_ORDER.flatMap((s) => gateCodes(p.id, s)),
          `${p.id} tailoring ${code}`,
        ).toContain(code)
    }
    // only the in-service project carries service data
    expect(seed.projects.filter((p: Any) => p.service).map((p: Any) => p.id)).toEqual(['PRJ-2023-011'])
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

  it('uses only the demo roles for people and actors', () => {
    const roles = new Set<string>(ROLES)
    const people: string[] = []
    const actors: string[] = []
    for (const p of seed.projects) people.push(p.manager, ...p.risks.map((r: Any) => r.owner))
    for (const s of seed.stages) {
      expect(roles.has(s.author), `${s.id} author`).toBe(true)
      actors.push(...s.history.map((h: Any) => h.by))
    }
    for (const g of seed.gates) {
      for (const r of g.approverRoles) expect(roles.has(r), `${g.id} approver role ${r}`).toBe(true)
      people.push(...g.findings.map((f: Any) => f.by), ...g.signatures.map((s: Any) => s.by))
    }
    for (const a of seed.artifacts) expect(roles.has(a.authorRole), `${a.id} author`).toBe(true)
    for (const c of seed.changes) {
      people.push(c.raisedBy, ...(c.ccb?.members ?? []))
      if (c.verification) people.push(c.verification.by)
      actors.push(...c.history.map((h: Any) => h.by))
    }
    for (const d of seed.defects) {
      people.push(d.owner)
      actors.push(...d.history.map((h: Any) => h.by))
    }
    for (const tr of seed.trials) {
      if (tr.witness) people.push(tr.witness)
      actors.push(...tr.history.map((h: Any) => h.by))
    }
    for (const f of seed.faults) actors.push(...f.history.map((h: Any) => h.by))
    for (const q of seed.problems) {
      people.push(q.owner)
      actors.push(...q.history.map((h: Any) => h.by))
    }
    for (const by of people) expect(isPerson(by), `person ${by}`).toBe(true)
    for (const by of actors) expect(isActor(by), `actor ${by}`).toBe(true)
    // the 2.0.0 roles are gone
    for (const old of ['需求工程师', '软件架构师', '软件开发工程师', '测试工程师', '质量负责人', '研发总监'])
      expect(
        JSON.stringify([seed.projects, seed.gates, seed.stages, seed.changes, seed.defects]),
        old,
      ).not.toContain(old)
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
      'trials',
      'faults',
      'problems',
      'items',
      'configBaselines',
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
      // DOC-<project number>-<KIND>[-<suffix>]
      expect(a.id.startsWith(`DOC-${a.projectId.slice(-3)}-`), a.id).toBe(true)
    }
    for (const c of seed.changes) {
      for (const id of [...c.impact.reqs, ...c.impact.tests])
        expect(reqs.has(id), `${c.id} impact ${id}`).toBe(true)
      for (const id of c.impact.artifacts) expect(artifacts.has(id), `${c.id} impact ${id}`).toBe(true)
      for (const i of c.impact.items ?? []) {
        expect(
          seed.items.some((x: Any) => x.id === i.itemId && x.projectId === c.projectId),
          c.id,
        ).toBe(true)
        expect(i.fromRev).not.toBe(i.toRev)
      }
    }
    for (const d of seed.defects) {
      if (d.testCase) expect((reqs.get(d.testCase) as Any)?.level, d.id).toBe('TC')
      if (d.req) expect(reqs.has(d.req), d.id).toBe(true)
    }
    for (const tr of seed.trials) {
      for (const id of tr.verifies) {
        expect(reqs.has(id), `${tr.id} verifies ${id}`).toBe(true)
        expect((reqs.get(id) as Any).projectId, `${tr.id} verifies ${id}`).toBe(tr.projectId)
      }
      if (tr.changeId)
        expect(
          seed.changes.some((c: Any) => c.id === tr.changeId && c.projectId === tr.projectId),
          tr.id,
        ).toBe(true)
    }
    const v1 = (kind: string, id: string) => ids(seed[kind === 'task' ? 'tasks' : 'requirements']).has(id)
    for (const task of seed.tasks) {
      expect(v1('requirement', task.requirementId), task.id).toBe(true)
      for (const dep of task.dependsOn) expect(v1('task', dep), task.id).toBe(true)
    }
    for (const hi of seed.interventions) expect(v1(hi.entity.kind, hi.entity.id), hi.id).toBe(true)
  })

  it('keeps stage histories consistent', () => {
    for (const p of seed.projects) {
      const stages = STAGE_ORDER.map((name) => seed.stages.find((s: Any) => s.id === `${p.id}/${name}`))
      expect(stages.every(Boolean), p.id).toBe(true)
      const firstPassed = stages.map((s: Any) => s.history.find((h: Any) => h.to === 'PASSED')?.at)
      stages.forEach((s: Any, i: number) => {
        expect(s.author, `${s.id} author comes from the profile`).toBe(profileOf(p.id)[s.stage].author)
        expectChain(s, STAGE_MOVES, 'NOT_STARTED')
        // a stage starts only when the previous one is PASSED at that moment
        for (const h of s.history.filter(
          (x: Any) => x.to === 'IN_PROGRESS' && x.from === 'NOT_STARTED' && i > 0,
        )) {
          const prev = stages[i - 1].history.filter((x: Any) => t(x.at) <= t(h.at)).at(-1)
          expect(prev?.to, `${s.id} started before ${stages[i - 1].id} passed`).toBe('PASSED')
        }
        if (s.state === 'NOT_STARTED')
          expect(stages.slice(i).every((x: Any) => x.state === 'NOT_STARTED')).toBe(true)
        if (s.state === 'PASSED') expect(s.baseline && s.actualEnd, s.id).toBeTruthy()
        if (firstPassed[i] && i > 0) expect(firstPassed[i - 1], s.id).toBeTruthy()
      })
      expect(p.stage).toBe(stages.findLast((s: Any) => s.state !== 'NOT_STARTED').stage)
      // in-service projects are finished and never re-opened by a change
      if (p.service) for (const s of stages) expect(s.state, s.id).toBe('PASSED')
    }
    for (const a of seed.artifacts) {
      const stage = seed.stages.find((s: Any) => s.id === `${a.projectId}/${a.stage}`)
      if (a.status === 'BASELINED') expect(stage.state, a.id).toBe('PASSED')
      if (a.status === 'IN_REVIEW') expect(stage.state, a.id).toBe('IN_REVIEW')
    }
    expect(seed.stages.some((s: Any) => s.state === 'IN_PROGRESS' && t(s.plannedEnd) < NOW)).toBe(true)
  })

  it('keeps every gate inside its project profile, in order, with consistent signatures', () => {
    for (const g of seed.gates) {
      const stage = seed.stages.find((s: Any) => s.id === g.stageId)
      expect(g.id, g.id).toMatch(new RegExp(`^GATE-${stage.projectId}-${g.code}-\\d+$`))
      expect(g, g.id).not.toHaveProperty('approverRole')
      // the code belongs to this project's profile for this stage; name, type and roles are the profile's
      const def = profileOf(stage.projectId)[stage.stage].gates.find((x: Any) => x.code === g.code)
      expect(def, `${g.id} code ${g.code} in ${stage.projectId} ${stage.stage}`).toBeDefined()
      expect({ name: g.name, type: g.type, approverRoles: g.approverRoles }, g.id).toEqual({
        name: def.name,
        type: def.type,
        approverRoles: def.approverRoles,
      })
      expect(g.approverRoles, `${g.id} approver is the author`).not.toContain(stage.author)
      // submitted before it was decided, so 「我的待办」 can order the gates by time
      expect(t(g.submittedAt), `${g.id} submittedAt`).toBeLessThanOrEqual(g.decidedAt ? t(g.decidedAt) : NOW)
      expect(ids(g.findings).size).toBe(g.findings.length)
      const signed = g.signatures.map((s: Any) => s.role)
      expect(new Set(signed).size, `${g.id} one signature per role`).toBe(signed.length)
      for (const s of g.signatures) {
        expect(g.approverRoles, `${g.id} signer ${s.by}`).toContain(s.role)
        expect(s.by.startsWith(`${s.role} `), `${g.id} signer ${s.by}`).toBe(true)
        expect(t(s.at), `${g.id} signed after the decision`).toBeLessThanOrEqual(
          g.decidedAt ? t(g.decidedAt) : NOW,
        )
      }
      if (g.decision === 'PENDING') {
        expect(stage.state, g.id).toBe('IN_REVIEW')
        expect(g.decidedAt).toBeUndefined()
        expect(signed.length, `${g.id} still waits for a role`).toBeLessThan(g.approverRoles.length)
      } else if (g.decision === 'APPROVED') {
        expect([...signed].sort(), `${g.id} all roles signed`).toEqual([...g.approverRoles].sort())
        expect(
          g.findings.every((f: Any) => f.closed),
          `${g.id} open findings`,
        ).toBe(true)
      } else {
        // a rejection is recorded in the comment; signatures only hold approvals given before it
        expect(g.decision).toBe('REJECTED')
        expect(signed.length, `${g.id} rejected despite a full set of signatures`).toBeLessThan(
          g.approverRoles.length,
        )
        expect(g.comment, g.id).toBeTruthy()
      }
    }
    // gate attempts: n counts per project and code, starting at 1
    const attempts = new Map<string, number[]>()
    for (const g of seed.gates) {
      const stage = seed.stages.find((s: Any) => s.id === g.stageId)
      const key = `${stage.projectId}/${g.code}`
      attempts.set(key, [...(attempts.get(key) ?? []), Number(g.id.split('-').at(-1))])
    }
    for (const [key, list] of attempts) expect(list, key).toEqual(list.map((_, i) => i + 1))

    for (const s of seed.stages) {
      const mine = seed.gates.filter((g: Any) => g.stageId === s.id)
      const exits = s.history.filter((h: Any) => h.from === 'IN_REVIEW')
      const decided = mine
        .filter((g: Any) => g.decision !== 'PENDING')
        .sort((a: Any, b: Any) => t(a.decidedAt) - t(b.decidedAt))
      const pending = mine.filter((g: Any) => g.decision === 'PENDING')
      expect(decided.length, `${s.id} decided gates`).toBe(exits.length)
      expect(pending.length, s.id).toBe(s.state === 'IN_REVIEW' ? 1 : 0)
      const codes = gateCodes(s.projectId, s.stage)
      const approved = new Set<string>()
      let reopened = false
      ;[...decided, ...pending].forEach((g: Any, i: number) => {
        // the next gate is the first one not yet approved; after a CR sent a passed stage back, the last one
        const expected = reopened ? codes.at(-1) : codes.find((c: string) => !approved.has(c))
        expect(g.code, `${g.id} is not the next gate of ${s.id}`).toBe(expected)
        reopened = false
        const exit = exits[i]
        if (!exit) return
        expect(exit.at, `${g.id} decided at the stage exit`).toBe(g.decidedAt)
        if (g.decision === 'REJECTED') expect(exit.to, g.id).toBe('REWORK')
        else {
          approved.add(g.code)
          const next = codes.find((c: string) => !approved.has(c))
          if (next) {
            expect(exit.to, g.id).toBe('IN_PROGRESS')
            expect(exit.note, g.id).toBe(`${g.code} 已通过，进入 ${next}`)
          } else expect(exit.to, g.id).toBe('PASSED')
        }
        const after = exits[i + 1] ? t(exits[i + 1].at) : Number.POSITIVE_INFINITY
        reopened = s.history.some(
          (h: Any) => h.from === 'PASSED' && h.to === 'REWORK' && t(h.at) > t(exit.at) && t(h.at) < after,
        )
      })
      if (s.state === 'PASSED')
        for (const c of codes) expect(approved.has(c), `${s.id} ${c} approved`).toBe(true)
    }
  })

  it('has the demo gates: customer countersign pending, held findings, full IPD history', () => {
    const dl2 = seed.gates.find((g: Any) => g.id === 'GATE-PRJ-2026-008-DL2-1')
    expect(dl2).toMatchObject({ code: 'DL2', decision: 'PENDING' })
    expect(dl2.signatures.map((s: Any) => s.role)).toEqual(['项目经理'])
    expect(dl2.findings.filter((f: Any) => !f.closed)).toHaveLength(2)
    // 042 sits in VERIFICATION with the TYPE gate not yet submitted
    expect(seed.stages.find((s: Any) => s.id === 'PRJ-2025-042/VERIFICATION')).toMatchObject({
      state: 'IN_PROGRESS',
    })
    expect(seed.gates.some((g: Any) => g.stageId === 'PRJ-2025-042/VERIFICATION')).toBe(false)
    // 019 walks the complete IPD profile without tailoring
    expect(project('PRJ-2025-019').tailoring).toBeUndefined()
    expect(
      seed.gates
        .filter((g: Any) => g.stageId.startsWith('PRJ-2025-019/') && g.decision === 'APPROVED')
        .map((g: Any) => g.code),
    ).toEqual(['CDCP', 'TR1', 'TR2', 'TR3', 'PDCP', 'TR4', 'TR5', 'TR6', 'ADCP'])
    // a CR approved after the stage passed re-submits the last gate only
    expect(seed.gates.filter((g: Any) => g.stageId === 'PRJ-2025-042/DESIGN').map((g: Any) => g.id)).toEqual([
      'GATE-PRJ-2025-042-DL2-1',
      'GATE-PRJ-2025-042-FREEZE-1',
      'GATE-PRJ-2025-042-FREEZE-2',
    ])
  })

  it('structures requirements by discipline with part numbers, drawings and technical-agreement responses', () => {
    for (const r of seed.reqs) {
      if (r.level === 'SWR') {
        expect(r.id, r.id).toMatch(/^(SWR|MER|EER)-\d+$/)
        expect(r.discipline, r.id).toBe({ SWR: 'SW', MER: 'MECH', EER: 'ELEC' }[r.id.slice(0, 3) as 'SWR'])
      } else {
        expect(r.id.startsWith(`${r.level}-`), r.id).toBe(true)
        if (r.level !== 'DES') expect(r.discipline, r.id).toBeUndefined()
      }
      if (r.level === 'DES') {
        expect(['MECH', 'ELEC', 'SW'], r.id).toContain(r.discipline)
        if (r.discipline === 'SW') expect(r.module, r.id).toBeTruthy()
        else {
          expect(r.partNo, r.id).toMatch(/^NC-[A-Z]{2}-\d{4}$/)
          expect(r.drawingNo, r.id).toBeTruthy()
        }
      }
      if (r.level === 'CUS') {
        expect(r.clause, r.id).toMatch(/^TA-\d{3} §\d/)
        expect(['COMPLY', 'DEVIATE', 'CLARIFY'], r.id).toContain(r.compliance)
        if (r.compliance !== 'COMPLY') expect(r.responseNote, r.id).toBeTruthy()
      }
    }
    const of042 = seed.reqs.filter((r: Any) => r.projectId === 'PRJ-2025-042')
    for (const level of ['SWR', 'DES'])
      expect(new Set(of042.filter((r: Any) => r.level === level).map((r: Any) => r.discipline))).toEqual(
        new Set(['MECH', 'ELEC', 'SW']),
      )
    const cus = of042.filter((r: Any) => r.level === 'CUS')
    expect(cus.filter((r: Any) => r.compliance === 'DEVIATE')).toHaveLength(2)
    expect(cus.filter((r: Any) => r.compliance === 'CLARIFY')).toHaveLength(1)
    // part numbers are unique per physical part within a project
    const parts = of042.filter((r: Any) => r.partNo).map((r: Any) => r.partNo)
    expect(new Set(parts).size).toBe(parts.length)
    // an SWR is VERIFIED exactly when all its TCs are, so the first real run does not demote it
    for (const swr of seed.reqs.filter((r: Any) => r.level === 'SWR')) {
      const tcs = seed.reqs.filter((r: Any) => r.level === 'TC' && r.parent.includes(swr.id))
      if (swr.status === 'VERIFIED')
        expect(
          tcs.filter((tc: Any) => tc.status !== 'VERIFIED').map((tc: Any) => tc.id),
          swr.id,
        ).toEqual([])
    }
  })

  it('keeps trials consistent with the trial state machine and the change they depend on', () => {
    const prefix = { TYPE_TEST: 'TT', ROUTINE: 'RT', FAT: 'FAT', FAI: 'FAI' } as const
    const LABS = ['CNAS 车门试验检测中心', '主机厂现场']
    for (const tr of seed.trials) {
      expect(tr.id, tr.id).toMatch(new RegExp(`^${prefix[tr.type as keyof typeof prefix]}-\\d{4}-\\d{3}$`))
      expect(LABS, tr.id).toContain(tr.lab)
      expect(tr.standard && tr.sample, tr.id).toBeTruthy()
      expectChain(tr, TRIAL_MOVES, null)
      if (['REPORTED', 'APPROVED'].includes(tr.state)) {
        expect(tr.reportNo, tr.id).toBeTruthy()
        expect(tr.result, tr.id).not.toBe('PENDING')
      }
      if (['PLANNED', 'IN_PROGRESS'].includes(tr.state)) expect(tr.result, tr.id).toBe('PENDING')
      if (tr.state === 'APPROVED' && tr.result === 'FAIL') {
        const change = seed.changes.find((c: Any) => c.id === tr.changeId)
        expect(['APPROVED', 'IMPLEMENTED', 'CLOSED'], `${tr.id} released with a failure`).toContain(
          change?.state,
        )
      }
      // a result other than PASS comes with the reason
      if (['FAIL', 'CONDITIONAL'].includes(tr.result)) expect(tr.deviations.length, tr.id).toBeGreaterThan(0)
      if (tr.state === 'PLANNED') expect(t(tr.plannedAt), tr.id).toBeGreaterThan(NOW - 30 * DAY)
    }
    const of042 = seed.trials.filter((x: Any) => x.projectId === 'PRJ-2025-042')
    const type042 = of042.filter((x: Any) => x.type === 'TYPE_TEST')
    expect(type042.length).toBeGreaterThanOrEqual(9)
    expect(of042.filter((x: Any) => x.type === 'FAI')).toHaveLength(1)
    for (const standard of ['EN 14752', 'IEC 61373', 'EN 50121-3-2', 'EN 45545', 'EN 50155'])
      expect(
        type042.some((x: Any) => x.standard.includes(standard)),
        standard,
      ).toBe(true)
    expect(type042.some((x: Any) => /-25 ℃/.test(x.title) && /夹紧力/.test(x.title))).toBe(true)
    expect(type042.some((x: Any) => /淋雨|水密/.test(x.title))).toBe(true)
    expect(type042.some((x: Any) => /寿命/.test(x.title))).toBe(true)
    // the failure chain: FAIL → CR-2026-019 → retest → PASS, retested after the change was approved
    const low = seed.trials.find((x: Any) => x.id === 'TT-2026-014')
    expect(low).toMatchObject({ result: 'PASS', state: 'APPROVED', changeId: 'CR-2026-019' })
    expect(low.history.map((h: Any) => h.to)).toEqual([
      'PLANNED',
      'IN_PROGRESS',
      'REPORTED',
      'IN_PROGRESS',
      'REPORTED',
      'APPROVED',
    ])
    expect(low.history[2].note).toContain('FAIL')
    const cr019 = seed.changes.find((c: Any) => c.id === 'CR-2026-019')
    expect(cr019.source).toEqual({ type: 'TYPE_TEST', ref: 'TT-2026-014' })
    expect(t(cr019.ccb.at)).toBeGreaterThan(t(low.history[2].at))
    expect(t(cr019.ccb.at)).toBeLessThan(t(low.history[3].at))
    // an open failure without a change is what the "draft a change" scenario starts from
    expect(seed.trials.some((x: Any) => x.result === 'FAIL' && x.state === 'REPORTED' && !x.changeId)).toBe(
      true,
    )
    // the in-service project has an approved FAI and routine tests
    const of011 = seed.trials.filter((x: Any) => x.projectId === 'PRJ-2023-011')
    expect(of011.some((x: Any) => x.type === 'FAI' && x.state === 'APPROVED')).toBe(true)
    expect(of011.some((x: Any) => x.type === 'ROUTINE' && x.state === 'APPROVED')).toBe(true)
    // the TYPE and FAI gates of the finished project passed only after their trials were approved
    for (const [code, kind] of [
      ['TYPE', 'TYPE_TEST'],
      ['FAI', 'FAI'],
    ]) {
      const g = seed.gates.find((x: Any) => x.id === `GATE-PRJ-2023-011-${code}-1`)
      for (const tr of of011.filter((x: Any) => x.type === kind && x.state === 'APPROVED'))
        expect(t(tr.history.at(-1).at), `${tr.id} approved before ${g.id}`).toBeLessThanOrEqual(
          t(g.decidedAt),
        )
    }
  })

  it('keeps changes, defects and the v1 collections consistent', () => {
    for (const c of seed.changes) {
      expectChain(c, CR_MOVES, null)
      expect(['FIELD', 'TYPE_TEST', 'CUSTOMER', 'INTERNAL'], c.id).toContain(c.source.type)
      const states = c.history.map((h: Any) => h.to)
      if (states.includes('ANALYZED') && ['FIELD', 'TYPE_TEST'].includes(c.source.type))
        expect(c.rootCause, `${c.id} analysed without a root cause`).toBeTruthy()
      if (states.includes('APPROVED')) {
        expect(c.ccb?.decision, c.id).toBe('APPROVED')
        expect(c.ecn, c.id).toMatch(/^ECN-\d{4}-\d{3}$/)
        expect(c.ecn.slice(-3), c.id).toBe(c.id.slice(-3))
        // an approved CR sends every affected stage that had already passed back to rework, in-service ones excepted
        for (const artifactId of c.impact.artifacts) {
          const a = seed.artifacts.find((x: Any) => x.id === artifactId)
          const stage = seed.stages.find((s: Any) => s.id === `${a.projectId}/${a.stage}`)
          const before = stage.history.filter((h: Any) => t(h.at) < t(c.ccb.at)).at(-1)
          if (!project(c.projectId).service && before?.to === 'PASSED')
            expect(
              stage.history.some((h: Any) => h.to === 'REWORK' && h.at === c.ccb.at),
              `${c.id} ${stage.id}`,
            ).toBe(true)
        }
      } else expect(c.ecn, c.id).toBeUndefined()
      if (c.state === 'CLOSED')
        expect(c.verification?.result, `${c.id} closed without verification`).toBe('PASS')
      if (c.state === 'APPROVED')
        for (const id of c.impact.reqs)
          expect(seed.reqs.find((r: Any) => r.id === id).status, id).toBe('CHANGED')
    }
    expect(
      seed.changes
        .filter((c: Any) => c.projectId === 'PRJ-2025-042')
        .map((c: Any) => c.state)
        .sort(),
    ).toEqual(['CCB_REVIEW', 'IMPLEMENTED'])
    for (const d of seed.defects) {
      expectChain(d, DEFECT_MOVES, null)
      expect(Boolean(d.closedAt), d.id).toBe(d.state === 'CLOSED')
    }
    for (const kind of ['requirement', 'task', 'intervention'] as const)
      for (const item of seed[`${kind}s`]) expect(V1_STATES[kind], item.id).toContain(item.state)
    for (const state of V1_STATES.task)
      expect(
        seed.tasks.some((x: Any) => x.state === state),
        `task ${state}`,
      ).toBe(true)
    expect(seed.interventions.some((h: Any) => h.state === 'OPEN' && t(h.dueAt) < NOW)).toBe(true)
  })

  it('models the in-service fleet: service data, items, three baseline types and PHM faults', () => {
    const p = project('PRJ-2023-011')
    expect(p.service).toMatchObject({ phase: '质保期', trains: 40, doorsPerTrain: 48 })
    expect(t(p.service.deliveredAt)).toBeLessThan(NOW)
    expect(t(p.service.warrantyEnd)).toBeGreaterThan(NOW)
    expect(p.service.overhaul.length).toBeGreaterThan(0)
    for (const o of p.service.overhaul) {
      expect(['架修', '定修', '大修', '厂修']).toContain(o.level)
      expect(o.note, `${o.level} marked as an assumption`).toBe('项目技术规格书假设')
    }
    const doors = p.service.trains * p.service.doorsPerTrain

    const items = seed.items
    expect(items.filter((i: Any) => i.lru).length).toBeGreaterThanOrEqual(11)
    expect(new Set(items.map((i: Any) => i.discipline))).toEqual(new Set(['MECH', 'ELEC', 'SW']))
    for (const i of items) expect(i.id, i.id).toMatch(/^NC-[A-Z]{2}-\d{4}$/)

    const base = (type: string) =>
      seed.configBaselines.filter((b: Any) => b.type === type).sort((a: Any, b: Any) => t(a.at) - t(b.at))
    for (const type of ['AS_DESIGNED', 'AS_BUILT', 'AS_MAINTAINED']) {
      const list = base(type)
      expect(list.length, type).toBeGreaterThan(0)
      list.forEach((b: Any, i: number) => {
        expect(b.id, b.id).toBe(`CB-PRJ-2023-011-${type}-${String(i + 1).padStart(2, '0')}`)
        expect(Object.keys(b.revs).sort(), b.id).toEqual(items.map((x: Any) => x.id).sort())
      })
    }
    const diff = (a: Any, b: Any) => Object.keys(a.revs).filter((id) => a.revs[id] !== b.revs[id])
    const designed = base('AS_DESIGNED')
    const maintained = base('AS_MAINTAINED')
    // at the end the fleet is up to date: maintained equals designed, built keeps the shipped revision
    expect(diff(designed.at(-1), maintained.at(-1))).toEqual([])
    expect(diff(designed.at(-1), designed.at(-2))).toEqual(['NC-DR-1218'])
    expect(diff(base('AS_BUILT').at(-1), designed.at(-1))).toEqual(['NC-DR-1218'])

    // faults: ~40 PHM warnings with the six signals, dates relative to now, states of every kind
    const faults = seed.faults
    expect(faults.length).toBeGreaterThanOrEqual(35)
    expect(faults.length).toBeLessThanOrEqual(45)
    expect(new Set(faults.map((f: Any) => f.signal))).toEqual(
      new Set(['SLIDE', 'RESISTANCE', 'BUFFER_WEAR', 'OBSTACLE', 'LOCK_SWITCH', 'COMM']),
    )
    expect(new Set(faults.map((f: Any) => f.state))).toEqual(
      new Set(['NEW', 'DISPATCHED', 'HANDLED', 'CLOSED']),
    )
    expect(new Set(faults.map((f: Any) => f.source))).toEqual(new Set(['PHM', '客服', '主机厂']))
    expect(faults.filter((f: Any) => t(f.detectedAt) > NOW - 30 * DAY).length).toBeGreaterThanOrEqual(10)
    for (const f of faults) {
      expectChain(f, FAULT_MOVES, null)
      expect(f.id, f.id).toMatch(/^FA-2026-\d{4}$/)
      expect(f.train, f.id).toMatch(/^050(0[1-9]|[1-3]\d|40)$/)
      expect(['Mc1', 'T1', 'M1', 'M2', 'T2', 'Mc2'], f.id).toContain(f.car)
      expect(f.door, f.id).toMatch(/^[LR][1-4]$/)
      if (f.healthScore !== undefined) {
        expect(f.healthScore).toBeGreaterThanOrEqual(0)
        expect(f.healthScore).toBeLessThanOrEqual(100)
      }
      expect(t(f.detectedAt), f.id).toBeLessThanOrEqual(NOW)
      expect(f.history[0].at, f.id).toBe(f.detectedAt)
      if (f.problemId)
        expect(seed.problems.find((q: Any) => q.id === f.problemId)?.faultIds, f.id).toContain(f.id)
    }
    for (const q of seed.problems) {
      expectChain(q, PROBLEM_MOVES, null)
      expect(Object.keys(q.steps), q.id).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'])
      for (const id of q.faultIds) expect(faults.find((f: Any) => f.id === id)?.problemId, id).toBe(q.id)
      // the problem was opened after the first of its warnings
      const firstWarning = Math.min(
        ...q.faultIds.map((id: string) => t(faults.find((f: Any) => f.id === id).detectedAt)),
      )
      expect(t(q.history[0].at), q.id).toBeGreaterThanOrEqual(firstWarning)
      const reached = (state: string) => q.history.some((h: Any) => h.to === state)
      if (reached('ACTION')) {
        expect(q.rootCause, `${q.id} ACTION needs a root cause`).toBeTruthy()
        expect(q.steps.D4.done, `${q.id} ACTION needs D4`).toBe(true)
      }
      if (reached('CLOSED')) {
        expect(q.steps.D8.done, `${q.id} CLOSED needs D8`).toBe(true)
        expect(seed.changes.find((c: Any) => c.id === q.changeId)?.state, `${q.id} change`).toBe('CLOSED')
      }
    }

    // chain 1 (closed loop): warnings → QP-2026-003 → CR-2026-012 → ECN-2026-012 → routine test → retrofit → baseline
    const qp3 = seed.problems.find((q: Any) => q.id === 'QP-2026-003')
    const cr12 = seed.changes.find((c: Any) => c.id === 'CR-2026-012')
    const rt21 = seed.trials.find((x: Any) => x.id === 'RT-2026-021')
    expect(qp3).toMatchObject({ state: 'CLOSED', changeId: 'CR-2026-012' })
    expect(Object.values(qp3.steps).every((s: Any) => s.done && s.text)).toBe(true)
    expect(qp3.faultIds.length).toBeGreaterThanOrEqual(8)
    for (const id of qp3.faultIds) {
      const f = faults.find((x: Any) => x.id === id)
      expect(f, id).toMatchObject({ signal: 'BUFFER_WEAR', state: 'CLOSED' })
      expect(t(f.history.at(-1).at), `${id} closed before the problem closed`).toBeLessThanOrEqual(
        t(qp3.history.at(-1).at),
      )
    }
    expect(cr12).toMatchObject({
      state: 'CLOSED',
      ecn: 'ECN-2026-012',
      source: { type: 'FIELD', ref: 'QP-2026-003' },
      retrofit: { done: doors, total: doors },
    })
    expect(cr12.rootCause).toBeTruthy()
    expect(cr12.impact.items).toEqual([{ itemId: 'NC-DR-1218', fromRev: 'B', toRev: 'C' }])
    expect(cr12.impact.fleet.doors).toBe(doors)
    expect(cr12.verification).toMatchObject({ result: 'PASS', trialId: 'RT-2026-021' })
    expect(rt21).toMatchObject({
      type: 'ROUTINE',
      result: 'PASS',
      state: 'APPROVED',
      changeId: 'CR-2026-012',
    })
    // order of events along the chain
    const at = (history: Any[], state: string) => t(history.find((h: Any) => h.to === state).at)
    expect(at(qp3.history, 'OPEN')).toBeLessThan(at(cr12.history, 'SUBMITTED'))
    expect(at(cr12.history, 'APPROVED')).toBe(t(cr12.ccb.at))
    expect(t(designed.at(-1).at), 'designed baseline is written on approval').toBe(t(cr12.ccb.at))
    expect(at(qp3.history, 'ACTION')).toBeGreaterThanOrEqual(t(cr12.ccb.at) - DAY)
    expect(t(rt21.history.at(-1).at)).toBeLessThanOrEqual(t(cr12.verification.at))
    expect(t(cr12.verification.at)).toBeLessThanOrEqual(at(cr12.history, 'CLOSED'))
    expect(t(maintained.at(-1).at), 'maintained catches up after the retrofit started').toBeGreaterThan(
      at(cr12.history, 'IMPLEMENTED'),
    )
    expect(t(maintained.at(-1).at)).toBeLessThanOrEqual(at(cr12.history, 'CLOSED'))
    expect(at(cr12.history, 'CLOSED')).toBeLessThanOrEqual(at(qp3.history, 'CLOSED'))
    // before the retrofit finished, maintained lagged designed by exactly the change impact
    expect(diff(designed.at(-1), maintained.at(-2))).toEqual(['NC-DR-1218'])
    expect(designed.at(-1).revs['NC-DR-1218']).toBe('C')

    // chain 2 (in progress): resistance warnings → QP-2026-007 ANALYZING, D1–D3 done, nothing decided yet
    const qp7 = seed.problems.find((q: Any) => q.id === 'QP-2026-007')
    expect(qp7.state).toBe('ANALYZING')
    expect(['D1', 'D2', 'D3'].every((k) => qp7.steps[k].done && qp7.steps[k].text)).toBe(true)
    expect(['D4', 'D5', 'D6', 'D7', 'D8'].every((k) => !qp7.steps[k].done)).toBe(true)
    expect(qp7.rootCause).toBeUndefined()
    expect(qp7.changeId).toBeUndefined()
    expect(seed.changes.some((c: Any) => c.source?.ref === 'QP-2026-007')).toBe(false)
    expect(qp7.faultIds.length).toBeGreaterThanOrEqual(5)
    for (const id of qp7.faultIds) expect(faults.find((f: Any) => f.id === id).signal).toBe('RESISTANCE')
    // newer resistance warnings are not attached yet: material for the next step
    expect(faults.some((f: Any) => f.signal === 'RESISTANCE' && !f.problemId && f.state === 'NEW')).toBe(true)
    // no baseline gap while the problem is analysed (checked above); one change is tied to the fleet
    expect(seed.changes.filter((c: Any) => c.projectId === 'PRJ-2023-011').map((c: Any) => c.id)).toEqual([
      'CR-2026-012',
    ])
  })

  it('keeps approval flows consistent with their objects, the demo roles and the node rules', () => {
    const roles = new Set<string>(ROLES)
    const subjects: Record<string, Any[]> = {
      artifact: seed.artifacts,
      change: seed.changes,
      problem: seed.problems,
      trial: seed.trials,
    }
    const running = new Set<string>()
    for (const f of seed.approvals) {
      const subject = subjects[f.subject.type].find((x: Any) => x.id === f.subject.id)
      expect(subject, `${f.id} subject`).toBeTruthy()
      expect(subject.projectId, `${f.id} project`).toBe(f.projectId)
      expect(f.initiator.by.startsWith(`${f.initiator.role} `), `${f.id} initiator`).toBe(true)
      expect(isPerson(f.initiator.by), `${f.id} initiator`).toBe(true)
      for (const n of f.nodes)
        for (const r of n.roles) expect(roles.has(r), `${f.id} ${n.id} role`).toBe(true)
      let at = t(f.startedAt)
      for (const a of f.actions) {
        expect(isPerson(a.by), `${f.id} actor ${a.by}`).toBe(true)
        expect(roles.has(a.role), `${f.id} role ${a.role}`).toBe(true)
        expect(
          f.nodes.some((n: Any) => n.id === a.nodeId),
          `${f.id} node ${a.nodeId}`,
        ).toBe(true)
        expect(t(a.at), `${f.id} action order`).toBeGreaterThanOrEqual(at)
        at = t(a.at)
      }
      if (f.state === 'RUNNING') {
        expect(running.has(`${f.subject.type}/${f.subject.id}`), `${f.id} second running flow`).toBe(false)
        running.add(`${f.subject.type}/${f.subject.id}`)
        expect(f.nodes[f.current].state).toBe('ACTIVE')
      } else {
        expect(
          f.nodes.every((n: Any) => n.state === 'DONE'),
          `${f.id} nodes`,
        ).toBe(f.state === 'APPROVED')
        expect(t(f.endedAt)).toBe(at)
      }
      // what the flow says about its object
      if (f.template === 'DOC_RELEASE') expect(subject.status, f.id).toBe('BASELINED')
      if (f.template === 'ECR' && f.state === 'RUNNING') expect(subject.state, f.id).toBe('CCB_REVIEW')
      if (f.template === 'ECR' && f.state === 'APPROVED') {
        expect(subject.ecn, f.id).toBeTruthy()
        expect(t(subject.ccb.at), `${f.id} CCB time`).toBe(t(f.endedAt))
      }
      if (f.template === 'ECN_RELEASE') expect(subject.ecn, f.id).toBeTruthy()
      if (f.template === 'PROBLEM_CLOSE') {
        expect(subject.state, f.id).toBe('CLOSED')
        expect(t(subject.history.at(-1).at), `${f.id} close time`).toBe(t(f.endedAt))
      }
      if (f.template === 'TRIAL_REPORT') expect(subject.state, f.id).toBe('REPORTED')
    }
    // the demo always has a running, a returned, a transferred, an added-signer and an overdue flow
    const has = (pred: (f: Any) => boolean) => seed.approvals.some(pred)
    expect(has((f) => f.state === 'RUNNING')).toBe(true)
    expect(has((f) => f.actions.some((a: Any) => a.action === 'RETURN'))).toBe(true)
    expect(has((f) => f.actions.some((a: Any) => a.action === 'TRANSFER'))).toBe(true)
    expect(has((f) => f.nodes.some((n: Any) => n.addedBy))).toBe(true)
    expect(has((f) => f.nodes.some((n: Any) => isOverdue(f, n, NOW)))).toBe(true)
    // the planned flows: SAD and test plan, CR-2026-019 ECR and ECN, CR-2026-031 ECR, QP-2026-003, a type-test report
    expect(seed.approvals.map((f: Any) => `${f.template} ${f.subject.id}`)).toEqual([
      'DOC_RELEASE DOC-042-SAD',
      'DOC_RELEASE DOC-042-TEST-PLAN',
      'ECR CR-2026-019',
      'ECN_RELEASE CR-2026-019',
      'ECR CR-2026-031',
      'PROBLEM_CLOSE QP-2026-003',
      'TRIAL_REPORT TT-2026-019',
    ])
  })

  it('ships one document per artifact and every id a document cites exists', () => {
    const files = readdirSync(DOCS, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.md'))
      .sort()
    const expected = seed.artifacts.map((a: Any) => join(a.projectId, `${a.source.docId}.md`)).sort()
    expect(files).toEqual(expected)
    // the documents added with the v3 profiles
    for (const [projectId, docId, kind] of [
      ['PRJ-2025-042', 'DOC-042-TA-RESP', 'TA_RESPONSE'],
      ['PRJ-2025-042', 'DOC-042-DL2-MIN', 'DL_MINUTES'],
      ['PRJ-2025-042', 'DOC-042-TT-PLAN', 'TYPE_TEST_PLAN'],
      ['PRJ-2025-042', 'DOC-042-TT-RPT-07', 'TYPE_TEST_REPORT'],
      ['PRJ-2023-011', 'DOC-011-FAI', 'FAI_REPORT'],
      ['PRJ-2023-011', 'DOC-011-8D-003', 'REPORT_8D'],
      ['PRJ-2023-011', 'DOC-011-ECN-012', 'ECN'],
      ['PRJ-2023-011', 'DOC-011-ACCEPT', 'ACCEPTANCE'],
    ])
      expect(
        seed.artifacts.find((a: Any) => a.id === docId),
        docId,
      ).toMatchObject({ projectId, kind })
    const known = new Set<string>([
      ...seed.reqs.map((r: Any) => r.id),
      ...seed.reqs.flatMap((r: Any) => (r.partNo ? [r.partNo] : [])),
      ...seed.changes.flatMap((c: Any) => [c.id, ...(c.ecn ? [c.ecn] : [])]),
      ...seed.defects.map((d: Any) => d.id),
      ...seed.artifacts.map((a: Any) => a.id),
      ...seed.testRuns.map((r: Any) => r.id),
      ...seed.trials.map((x: Any) => x.id),
      ...seed.faults.map((x: Any) => x.id),
      ...seed.problems.map((x: Any) => x.id),
      ...seed.items.map((x: Any) => x.id),
      ...seed.configBaselines.map((x: Any) => x.id),
      ...seed.gates.map((x: Any) => x.id),
      ...seed.stages.flatMap((s: Any) => (s.baseline ? [s.baseline.id] : [])),
      ...seed.projects.flatMap((p: Any) => [p.id, ...p.risks.map((r: Any) => r.id)]),
    ])
    const ID =
      /\b(?:CUS|SYS|SWR|MER|EER|DES|TC|CR|DEF|DOC|TR|BL|PRJ|RSK|TT|RT|FAT|FAI|FA|QP|ECN|CB|GATE|NC)-[A-Za-z0-9._-]*[A-Za-z0-9]/g
    for (const file of files) {
      const text = readFileSync(join(DOCS, file), 'utf8')
      expect(text, file).toContain('虚构企业与模拟数据')
      expect(text, `${file} marks its limits as assumptions`).toContain('项目技术规格书假设')
      const cited = text.match(ID) ?? []
      expect(cited.length, file).toBeGreaterThan(0)
      for (const id of cited) expect(known.has(id), `${file} cites unknown ${id}`).toBe(true)
      const ipd = /\b(CDCP|PDCP|ADCP|TR[1-6])\b/.test(text)
      if (file.startsWith('PRJ-2025-019'))
        expect(!ipd || text.includes('按 IPD 裁剪（推断）'), file).toBe(true)
      // order projects use design liaison, freeze and type test names, not the IPD ones
      else expect(ipd, `${file} uses IPD names for an order project`).toBe(false)
    }
  })

  it('keeps real companies, lines, customers and train families out of the public repository', () => {
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
      // vehicle builders, overseas customers and door and brake suppliers
      'Q0FG',
      'VGFsZ28=',
      'U2llbWVucw==',
      'Qm9tYmFyZGllcg==',
      'SGl0YWNoaQ==',
      'S2F3YXNha2k=',
      'TmFidGVzY28=',
      'RmFpdmVsZXk=',
      'V2FidGVj',
      'S25vcnI=',
      '6KW/6Zeo5a2Q',
      '5bqe5be06L+q',
      '5pel56uL',
      '5bed5bSO',
      '57qz5Y2a54m55pav5YWL',
      '5rOV57u06I6x',
      '5YWL6K+65bCU',
      // high-speed train family names and more real metro operators
      '5aSN5YW05Y+3',
      '5ZKM6LCQ5Y+3',
      'Q1I0MDA=',
      'Q1JI',
      '5rex5Zyz5Zyw6ZOB',
      '5p2t5bee5Zyw6ZOB',
      '5oiQ6YO95Zyw6ZOB',
      '5riv6ZOB',
    ].map((b) => Buffer.from(b, 'base64').toString('utf8').toLowerCase())
    const here = dirname(fileURLToPath(import.meta.url))
    const files = [
      join(here, '..', 'seed-data.mjs'),
      join(here, '..', 'profiles.mjs'),
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
