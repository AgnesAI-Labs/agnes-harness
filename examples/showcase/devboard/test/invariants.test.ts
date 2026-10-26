// Deterministic invariant fuzz of the DevBoard domain. A seeded PRNG drives valid-looking calls of the
// exported domain API through `update` on an in-memory store (the 64 KiB value cap included); after every
// successful call the invariants below are checked on the persisted state. A refused call (DomainError) is
// expected and skipped. A violation is shrunk to a minimal call sequence and printed with the failure.
// Known violations are listed in KNOWN. The walk skips their invariant; each one's fixed repro is `it.fails`,
// so it turns red when the violation is fixed: then delete its KNOWN entry. A walk failure is a new violation:
// fix it, or list it in KNOWN with a repro taken from the shrunk sequence printed with the failure.
import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_LIMIT,
  actApproval,
  coverage,
  create,
  DomainError,
  decideGate,
  dismissHandback,
  HANDBACK_LIMIT,
  MACHINES,
  pendingHandbacks,
  read,
  recordArtifact,
  recordTestRun,
  STAGES,
  SUMMARY_LIMIT,
  seed,
  snapshot,
  submitApproval,
  submitGate,
  transition,
  update,
  updateChange,
  upsertProblem,
  upsertReqs,
  upsertTrial,
} from '../domain.mjs'
import { handoff } from '../handoff.mjs'
import { GATE_PROFILES, ROLES } from '../profiles.mjs'

// biome-ignore lint/suspicious/noExplicitAny: domain.mjs is untyped JavaScript, the state is plain data
type S = any
// `must` names the invariant that fails when this call is refused (a call that is valid by construction)
type Op = { fn: string; args: S; now: number; must?: string }
type Store = ReturnType<typeof memoryStore>
type Ctx = { before?: S; after: S; op?: Op; store: Store; docsBefore?: Map<string, unknown>; heavy: boolean }

const T0 = Date.parse('2026-10-21T08:00:00Z')
const HOUR = 3_600_000
const HISTORY_LIMIT = 30
// an APPROVE by a role the node still awaits is never refused for a reason the caller cannot remove
const MUST = 'a-correctly-agreed-flow-step-is-never-refused'

// Known violations (invariant name, or `seed:<name>` when the untouched seed already breaks it) -> what is wrong.
type Known = {
  why: string
  /** A shortest call sequence from the untouched seed that breaks the invariant (its own case is `it.fails`). */
  repro?: Omit<Op, 'now'>[]
}
const approve = (id: string, role: string) => ({
  fn: 'actApproval',
  args: { id, action: 'APPROVE', by: `${role} 测试员` },
  must: MUST,
})
const chain = (P: string) => ({
  fn: 'upsertReqs',
  args: {
    projectId: P,
    items: [
      { id: 'CUS-950', title: 'c', text: 'c' },
      { id: 'SYS-950', title: 's', text: 's', parent: ['CUS-950'] },
      { id: 'SWR-950', title: 'r', text: 'r', parent: ['SYS-950'] },
      { id: 'SWR-951', title: 'r', text: 'r', parent: ['SYS-950'] },
      { id: 'TC-950', title: 't', text: 't', parent: ['SWR-950'] },
    ],
  },
})
const passTc = (P: string) => ({
  fn: 'recordTestRun',
  args: { projectId: P, results: [{ tc: 'TC-950', status: 'pass' }] },
})

const KNOWN: Record<string, Known> = {
  'seed:change-is-approved-only-by-an-approved-ecr': {
    why: 'seed change CR-2025-063 (PRJ-2025-019) is CLOSED with a CCB approval and an ECN but has no ECR flow: its history cannot be reached through the rules',
  },
  'seed:stage-gates-are-taken-in-order': {
    why: 'seed PRJ-2025-042/DESIGN holds DL2-1, FREEZE-1 and FREEZE-2 all APPROVED and none superseded: after the CR-2026-019 rework the domain would have superseded DL2-1 and FREEZE-1 (applyChange) and asked for DL2 again',
  },
  'seed:stage-state-matches-its-gates': {
    why: 'same seed stage as above: PASSED with gates DL2,FREEZE,FREEZE approved instead of DL2,FREEZE',
  },
  'a-stage-goes-to-review-only-after-the-earlier-ones-passed': {
    why: 'applyChange (domain.mjs, "const reworked" loop) sends only the impacted stages to REWORK and leaves a later IN_REVIEW stage and its PENDING gate alone, so an earlier stage is in rework while a later one is under review; decideGate refuses to approve that gate until the earlier stage passes again',
    repro: [
      approve('AP-2026-0025', '工艺工程师'),
      approve('AP-2026-0025', '软件设计师'),
      approve('AP-2026-0025', '质量工程师'),
      { fn: 'submitGate', args: { stageId: 'PRJ-2025-042/VERIFICATION', by: '研发协调员' } },
      approve('AP-2026-0025', '技术负责人'),
    ],
  },
  'a-change-under-a-running-flow-is-not-edited': {
    why: 'updateChange (domain.mjs) records a note or a verification, and setRetrofit (transition kind retrofit) advances retrofit.done, on a change whose ECN_RELEASE flow is running: neither calls runningFlow. The README freezes only the retrofit total; a trial, problem or deliverable under a flow refuses every edit',
  },
  'swr-with-all-cases-verified-is-not-left-approved': {
    why: 'upsertReqs only un-verifies an SWR when a case leaves it; a VERIFIED case moved under an SWR that is not VERIFIED leaves that SWR APPROVED although all its cases are VERIFIED (only a test run verifies an SWR, so the next run on the case would fix it)',
    repro: [
      chain('PRJ-2025-042'),
      passTc('PRJ-2025-042'),
      {
        fn: 'upsertReqs',
        args: { projectId: 'PRJ-2025-042', items: [{ id: 'SWR-951', status: 'APPROVED' }] },
      },
      {
        fn: 'upsertReqs',
        args: { projectId: 'PRJ-2025-042', items: [{ id: 'TC-950', parent: ['SWR-951'] }] },
      },
    ],
  },
}

// ── Harness ───────────────────────────────────────────────────────────────────────────────────────
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function memoryStore() {
  const rows = new Map<string, unknown>()
  const counts = { sets: 0, deletes: 0 }
  return {
    rows,
    counts,
    get: (key: string) => (rows.has(key) ? structuredClone(rows.get(key)) : undefined),
    set: (key: string, value: unknown) => {
      // The host caps each value at 64 KiB of JSON.
      if (new TextEncoder().encode(JSON.stringify(value)).length > 65536) throw new Error('INVALID_PARAMS')
      counts.sets++
      rows.set(key, structuredClone(value))
    },
    delete: (key: string) => {
      counts.deletes++
      rows.delete(key)
    },
    transaction: <T>(work: () => T) => work(),
  }
}

const APPLY: Record<string, (state: S, args: S, now: number) => unknown> = {
  transition,
  submitGate,
  decideGate,
  upsertReqs,
  recordTestRun,
  recordArtifact,
  updateChange,
  upsertTrial,
  upsertProblem,
  create,
  submitApproval,
  actApproval,
  dismissHandback: (state, args) => dismissHandback(state, args),
}

// the coordinator's tool behind a call, for the activity line its write leaves
const TOOLS: Record<string, (a: S) => string | undefined> = {
  transition: () => 'devboard_transition',
  create: (a) =>
    (
      ({
        project: 'devboard_project_create',
        change: 'devboard_change_upsert',
        defect: 'devboard_defect_upsert',
      }) as S
    )[a.kind],
  submitGate: () => 'devboard_gate_submit',
  upsertReqs: () => 'devboard_req_upsert',
  recordTestRun: () => 'devboard_test_record',
  recordArtifact: () => 'devboard_artifact_record',
  updateChange: () => 'devboard_change_upsert',
  upsertTrial: () => 'devboard_trial_upsert',
  upsertProblem: () => 'devboard_problem_upsert',
  submitApproval: () => 'devboard_approval_submit',
}
const byId = (list: S[], id: string) => list.find((x: S) => x.id === id)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const gatesOf = (project: S, stage: string): S[] =>
  ((GATE_PROFILES as S)[project.kind]?.[stage]?.gates ?? []).filter(
    (g: S) => !project.tailoring?.skipped?.includes(g.code),
  )
const flowsOf = (state: S, type: string, id: string): S[] =>
  state.approvals.filter((a: S) => a.subject.type === type && a.subject.id === id)
const SUBJECT_LIST: Record<string, string> = {
  artifact: 'artifacts',
  change: 'changes',
  problem: 'problems',
  trial: 'trials',
}
const hop = (kind: string, from: string, to: string) =>
  from === to || (MACHINES as S)[kind][from]?.includes(to)
const approvedFlow = (state: S, type: string, id: string, template: string) =>
  flowsOf(state, type, id).some((a) => a.template === template && a.state === 'APPROVED')
const casesBySwr = (state: S) => {
  const map = new Map<string, S[]>()
  for (const t of state.reqs)
    if (t.level === 'TC')
      for (const p of t.parent ?? [])
        map.set(`${t.projectId}/${p}`, [...(map.get(`${t.projectId}/${p}`) ?? []), t])
  return map
}
const full = (cr: S) => cr?.retrofit?.total > 0 && cr.retrofit.done === cr.retrofit.total

// ── Invariants: each returns its violations as messages (ids only, so a message is stable) ─────────
type Check = (c: Ctx) => string[]
const INVARIANTS: Record<string, Check> = {
  'one-running-flow-per-object': ({ after }) => {
    const seen = new Map<string, number>()
    for (const a of after.approvals)
      if (a.state === 'RUNNING') {
        const k = `${a.subject.type}:${a.subject.id}`
        seen.set(k, (seen.get(k) ?? 0) + 1)
      }
    return [...seen].filter(([, n]) => n > 1).map(([k]) => `${k} has several RUNNING flows`)
  },

  'ids-unique': ({ after }) => {
    const out: string[] = []
    for (const [name, list] of Object.entries<S>(after)) {
      if (!Array.isArray(list)) continue
      const seen = new Set<string>()
      for (const x of list) {
        const key = `${name === 'reqs' ? x.projectId : ''}${x.id}`
        if (seen.has(key)) out.push(`${name}: duplicate id ${x.id}`)
        seen.add(key)
      }
    }
    return out
  },

  'retrofit-progress-never-decreases': ({ before, after }) => {
    const out: string[] = []
    for (const cr of after.changes) {
      const r = cr.retrofit
      if (r && !(r.done >= 0 && r.done <= r.total))
        out.push(`${cr.id} retrofit ${r.done}/${r.total} out of range`)
      const old = before && byId(before.changes, cr.id)?.retrofit
      if (old && r && r.done < old.done) out.push(`${cr.id} retrofit done fell ${old.done} -> ${r.done}`)
      if (old && !r) out.push(`${cr.id} lost its retrofit`)
    }
    return out
  },

  'completed-retrofit-has-exactly-one-as-maintained-baseline': ({ before, after }) => {
    const out: string[] = []
    const noted = (state: S, cr: S) =>
      state.configBaselines.filter(
        (b: S) =>
          b.projectId === cr.projectId &&
          b.type === 'AS_MAINTAINED' &&
          b.note === `${cr.ecn ?? cr.id} 整改完成`,
      ).length
    for (const cr of after.changes) {
      const n = noted(after, cr)
      if (n > 1) out.push(`${cr.id} has ${n} completion baselines`)
      if (!full(cr) && n) out.push(`${cr.id} has a completion baseline before its retrofit is complete`)
      const old = before && byId(before.changes, cr.id)
      if (old && full(cr) && !full(old) && n - noted(before, old) !== 1)
        out.push(`${cr.id} completed without exactly one new as-maintained baseline`)
    }
    if (before) {
      const count = (state: S) => state.configBaselines.filter((b: S) => b.type === 'AS_MAINTAINED').length
      const done = after.changes.filter((cr: S) => full(cr) && !full(byId(before.changes, cr.id))).length
      if (count(after) - count(before) !== done)
        out.push(`as-maintained baselines grew by ${count(after) - count(before)} for ${done} completion(s)`)
    }
    return out
  },

  'swr-verified-implies-all-its-cases-verified': ({ after }) => {
    const out: string[] = []
    const cases = casesBySwr(after)
    for (const swr of after.reqs.filter((r: S) => r.level === 'SWR' && r.status === 'VERIFIED')) {
      const tcs = cases.get(`${swr.projectId}/${swr.id}`) ?? []
      if (!tcs.length || tcs.some((t: S) => t.status !== 'VERIFIED'))
        out.push(`${swr.projectId} ${swr.id} VERIFIED with ${tcs.length} case(s), not all VERIFIED`)
    }
    return out
  },

  'swr-with-all-cases-verified-is-not-left-approved': ({ after }) => {
    const out: string[] = []
    const cases = casesBySwr(after)
    for (const swr of after.reqs.filter((r: S) => r.level === 'SWR' && r.status === 'APPROVED')) {
      const tcs = cases.get(`${swr.projectId}/${swr.id}`) ?? []
      if (tcs.length && tcs.every((t: S) => t.status === 'VERIFIED'))
        out.push(`${swr.projectId} ${swr.id} APPROVED although all ${tcs.length} case(s) are VERIFIED`)
    }
    return out
  },

  'verified-comes-only-from-test-runs': ({ before, after, op }) => {
    if (!before || op?.fn === 'recordTestRun') return []
    const out: string[] = []
    const was = new Map<string, S>(before.reqs.map((x: S) => [`${x.projectId}/${x.id}`, x]))
    for (const r of after.reqs) {
      if (!['SWR', 'TC'].includes(r.level) || r.status !== 'VERIFIED') continue
      const old = was.get(`${r.projectId}/${r.id}`)
      if (old?.status !== 'VERIFIED') out.push(`${r.projectId} ${r.id} became VERIFIED by ${op?.fn}`)
    }
    return out
  },

  'trace-links-are-consistent': ({ after }) => {
    const out: string[] = []
    const up: S = { SYS: 'CUS', SWR: 'SYS', DES: 'SWR', TC: 'SWR' }
    const disc: S = { SWR: 'SW', MER: 'MECH', EER: 'ELEC' }
    const index = new Map<string, S>(after.reqs.map((x: S) => [`${x.projectId}/${x.id}`, x]))
    for (const r of after.reqs) {
      const mine = (id: string) => index.get(`${r.projectId}/${id}`)
      const prefix = r.id.split('-')[0]
      if ((disc[prefix] ? 'SWR' : prefix) !== r.level) out.push(`${r.id} has level ${r.level}`)
      if (r.level === 'SWR' && disc[prefix] && r.discipline !== disc[prefix])
        out.push(`${r.projectId} ${r.id} has discipline ${r.discipline}`)
      for (const p of r.parent ?? []) {
        const parent = mine(p)
        if (!parent) out.push(`${r.projectId} ${r.id} has missing parent ${p}`)
        else if (parent.level !== up[r.level])
          out.push(`${r.projectId} ${r.id} has parent ${p} of level ${parent.level}`)
        else if (r.level === 'TC' && !parent.verifiedBy?.includes(r.id))
          out.push(`${r.projectId} ${p} does not list its case ${r.id}`)
      }
      for (const t of r.verifiedBy ?? [])
        if (!mine(t)?.parent?.includes(r.id))
          out.push(`${r.projectId} ${r.id} lists ${t} which does not point back`)
    }
    return out
  },

  'final-and-flow-locked-records-are-not-edited': ({ before, after, op, docsBefore, store }) => {
    if (!before) return []
    const out: string[] = []
    const finals: [string, string, S[]][] = [
      ['trial', 'APPROVED', before.trials],
      ['problem', 'CLOSED', before.problems],
    ]
    for (const [type, final, list] of finals)
      for (const old of list.filter((x: S) => x.state === final))
        if (!same(old, byId(after[SUBJECT_LIST[type] as string], old.id)))
          out.push(`${type} ${old.id} (${final}) changed by ${op?.fn}`)
    for (const flow of before.approvals.filter((a: S) => a.state === 'RUNNING')) {
      const { type, id } = flow.subject
      if (type === 'change' || (op?.fn === 'actApproval' && op.args.id === flow.id)) continue
      const old = byId(before[SUBJECT_LIST[type] as string], id)
      const now = byId(after[SUBJECT_LIST[type] as string], id)
      if (!old || !now) continue
      // a deliverable sent back to its initiator waits for its revision; its review status follows the gate
      const revising =
        type === 'artifact' && flow.current === 0 && flow.actions[flow.since - 1]?.to === 'INITIATOR'
      const strip = (x: S) => (type === 'artifact' ? { ...x, status: undefined } : x)
      if (!revising && !same(strip(old), strip(now)))
        out.push(`${type} ${id} changed by ${op?.fn} under running flow ${flow.id}`)
      if (
        type === 'artifact' &&
        !revising &&
        !same(docsBefore?.get(`devboard/doc/${id}`), store.rows.get(`devboard/doc/${id}`))
      )
        out.push(`${id} content changed by ${op?.fn} under running flow ${flow.id}`)
    }
    return out
  },

  'a-change-under-a-running-flow-is-not-edited': ({ before, after, op }) => {
    if (!before) return []
    const out: string[] = []
    for (const flow of before.approvals.filter(
      (a: S) => a.state === 'RUNNING' && a.subject.type === 'change',
    )) {
      if (op?.fn === 'actApproval' && op.args.id === flow.id) continue
      const old = byId(before.changes, flow.subject.id)
      const now = byId(after.changes, flow.subject.id)
      if (old && now && !same(old, now))
        out.push(`change ${old.id} changed by ${op?.fn} under running flow ${flow.id}`)
    }
    return out
  },

  'a-change-under-a-running-flow-keeps-everything-but-retrofit-progress': ({ before, after, op }) => {
    if (!before) return []
    const out: string[] = []
    const strip = (c: S) => ({
      ...c,
      history: undefined,
      retrofit: c.retrofit && { total: c.retrofit.total },
    })
    for (const flow of before.approvals.filter(
      (a: S) => a.state === 'RUNNING' && a.subject.type === 'change',
    )) {
      if (op?.fn === 'actApproval' && op.args.id === flow.id) continue
      const old = byId(before.changes, flow.subject.id)
      const now = byId(after.changes, flow.subject.id)
      if (old && now && !same(strip(old), strip(now)))
        out.push(`change ${old.id} changed by ${op?.fn} under running flow ${flow.id}`)
    }
    return out
  },

  'change-states-follow-the-machine': ({ before, after }) => {
    if (!before) return []
    const out: string[] = []
    for (const cr of after.changes) {
      const old = byId(before.changes, cr.id)
      if (!old && cr.state !== 'SUBMITTED') out.push(`${cr.id} was created ${cr.state}`)
      if (old && !hop('change', old.state, cr.state)) out.push(`${cr.id} moved ${old.state} -> ${cr.state}`)
    }
    return out
  },

  'change-is-approved-only-by-an-approved-ecr': ({ before, after, op }) => {
    const out: string[] = []
    for (const cr of after.changes) {
      const ecr = approvedFlow(after, 'change', cr.id, 'ECR')
      const old = before && byId(before.changes, cr.id)
      if (old?.state === 'CCB_REVIEW' && cr.state === 'APPROVED' && !(ecr && op?.fn === 'actApproval'))
        out.push(`${cr.id} CCB_REVIEW -> APPROVED by ${op?.fn} without an approved ECR`)
      if (cr.ccb?.decision === 'APPROVED' && !ecr) out.push(`${cr.id} has a CCB approval but no approved ECR`)
      if (cr.ccb?.decision === 'APPROVED' && !cr.ecn) out.push(`${cr.id} approved without an ECN`)
    }
    return out
  },

  'approved-change-keeps-its-analysis-and-closes-only-verified': ({ after }) => {
    const out: string[] = []
    for (const cr of after.changes) {
      const approved = cr.ccb?.decision === 'APPROVED'
      const i = cr.impact
      // ANALYZED stays editable on purpose: CCB review checks the analysis again
      const reviewed = ['CCB_REVIEW', 'APPROVED', 'IMPLEMENTED'].includes(cr.state)
      if (reviewed && ![i?.reqs, i?.artifacts, i?.tests, i?.items].some((l) => l?.length))
        out.push(`${cr.id} ${cr.state} with an empty impact analysis`)
      if (reviewed && ['FIELD', 'TYPE_TEST'].includes(cr.source?.type) && !cr.rootCause)
        out.push(`${cr.id} ${cr.state} without a root cause`)
      if (cr.state === 'CLOSED' && approved && cr.verification?.result !== 'PASS')
        out.push(`${cr.id} closed without a passing verification`)
      if (cr.ccb?.decision === 'REJECTED' && !['REJECTED', 'CLOSED'].includes(cr.state))
        out.push(`${cr.id} is ${cr.state} after a CCB rejection`)
    }
    return out
  },

  'a-finished-flow-settles-its-subject': ({ before, after }) => {
    if (!before) return []
    const out: string[] = []
    for (const flow of after.approvals) {
      const old = byId(before.approvals, flow.id)
      if (old?.state !== 'RUNNING' || flow.state === 'RUNNING') continue
      const { type, id } = flow.subject
      const s = byId(after[SUBJECT_LIST[type] as string], id)
      const t = flow.template
      const want: string[] | undefined = (
        {
          APPROVED: { ECR: ['APPROVED'], PROBLEM_CLOSE: ['CLOSED'], TRIAL_REPORT: ['APPROVED'] },
          REJECTED: { ECR: ['REJECTED'], PROBLEM_CLOSE: ['ACTION'], TRIAL_REPORT: ['IN_PROGRESS'] },
        } as S
      )[flow.state]?.[t]
      if (want && !want.includes(s?.state)) out.push(`${flow.id} ${t} ${flow.state} left ${id} ${s?.state}`)
      if (
        flow.state === 'APPROVED' &&
        type === 'artifact' &&
        (s?.status !== 'BASELINED' || /^V0\./.test(s.version))
      )
        out.push(`${flow.id} approved but ${id} is ${s?.status} ${s?.version}`)
      if (flow.state === 'APPROVED' && t === 'ECN_RELEASE' && s.impact?.items?.length) {
        const n = after.configBaselines.filter(
          (b: S) => b.type === 'AS_DESIGNED' && b.note?.startsWith(`${s.ecn}：`),
        ).length
        if (n !== 1) out.push(`${flow.id} released ${s.ecn} with ${n} as-designed baselines`)
      }
    }
    return out
  },

  'an-approved-change-sends-its-stages-to-rework': ({ before, after }) => {
    if (!before) return []
    const out: string[] = []
    for (const cr of after.changes) {
      const old = byId(before.changes, cr.id)
      if (!old || old.state === 'APPROVED' || cr.state !== 'APPROVED') continue
      for (const id of cr.impact?.reqs ?? []) {
        const r = after.reqs.find((x: S) => x.id === id && x.projectId === cr.projectId)
        if (r && r.status !== 'CHANGED') out.push(`${cr.id} approved but ${id} is ${r.status}`)
      }
      for (const sid of cr.reworked ?? []) {
        if (byId(after.stages, sid)?.state !== 'REWORK')
          out.push(`${cr.id} reworked ${sid} which is ${byId(after.stages, sid)?.state}`)
        if (after.gates.some((g: S) => g.stageId === sid && g.decision === 'PENDING'))
          out.push(`${cr.id} reworked ${sid} but a gate is still PENDING`)
      }
      if (byId(after.projects, cr.projectId)?.service && cr.reworked?.length)
        out.push(`${cr.id} reworked stages of an in-service project`)
    }
    return out
  },

  'stage-gates-are-taken-in-order': ({ after }) => {
    const out: string[] = []
    for (const stage of after.stages) {
      const project = byId(after.projects, stage.projectId)
      const mine = after.gates.filter((g: S) => g.stageId === stage.id)
      const def = gatesOf(project, stage.stage).map((g) => g.code)
      const approved = mine.filter((g: S) => !g.superseded && g.decision === 'APPROVED').map((g: S) => g.code)
      if (!same(approved, def.slice(0, approved.length)))
        out.push(`${stage.id} approved ${approved.join(',')} out of order (profile ${def.join(',')})`)
      const pending = mine.filter((g: S) => g.decision === 'PENDING')
      if (pending.length > 1) out.push(`${stage.id} has ${pending.length} PENDING gates`)
      if (pending[0] && pending[0].code !== def[approved.length])
        out.push(`${stage.id} pending ${pending[0].code} but ${def[approved.length]} is next`)
    }
    return out
  },

  'stage-state-matches-its-gates': ({ after }) => {
    const out: string[] = []
    for (const stage of after.stages) {
      const project = byId(after.projects, stage.projectId)
      const pending = after.gates.filter((g: S) => g.stageId === stage.id && g.decision === 'PENDING')
      if ((stage.state === 'IN_REVIEW') !== (pending.length === 1))
        out.push(`${stage.id} is ${stage.state} with ${pending.length} PENDING gate(s)`)
      if (stage.state === 'PASSED') {
        const def = gatesOf(project, stage.stage).map((g) => g.code)
        const approved = after.gates
          .filter((g: S) => g.stageId === stage.id && g.decision === 'APPROVED' && !g.superseded)
          .map((g: S) => g.code)
        if (!same(approved, def))
          out.push(`${stage.id} PASSED with gates ${approved.join(',')} of ${def.join(',')}`)
        if (!stage.baseline) out.push(`${stage.id} PASSED without a baseline`)
      }
    }
    return out
  },

  'approving-a-non-last-gate-keeps-the-stage-in-progress': ({ before, after }) => {
    if (!before) return []
    const out: string[] = []
    for (const g of after.gates) {
      const old = byId(before.gates, g.id)
      if (old?.decision !== 'PENDING' || g.decision !== 'APPROVED') continue
      const stage = byId(after.stages, g.stageId)
      const def = gatesOf(byId(after.projects, stage.projectId), stage.stage).map((x) => x.code)
      const last = def.indexOf(g.code) === def.length - 1
      if (!last && stage.state !== 'IN_PROGRESS')
        out.push(`${g.id} is not the last gate but ${stage.id} is ${stage.state}`)
      if (last && stage.state !== 'PASSED')
        out.push(`${g.id} is the last gate but ${stage.id} is ${stage.state}`)
    }
    return out
  },

  'a-stage-goes-to-review-only-after-the-earlier-ones-passed': ({ after }) => {
    const out: string[] = []
    for (const p of after.projects) {
      const st = STAGES.map((s) => byId(after.stages, `${p.id}/${s}`)).filter(Boolean)
      st.forEach((s: S, i: number) => {
        if (s.state === 'IN_REVIEW' && st.slice(0, i).some((e: S) => e.state !== 'PASSED'))
          out.push(`${s.id} IN_REVIEW while an earlier stage has not passed`)
        if (
          ['IN_PROGRESS', 'IN_REVIEW'].includes(s.state) &&
          st.slice(0, i).some((e: S) => e.state === 'NOT_STARTED')
        )
          out.push(`${s.id} ${s.state} while an earlier stage never started`)
      })
    }
    return out
  },

  'the-project-points-at-its-furthest-started-stage': ({ after }) => {
    // A reworked earlier stage may run again beside it: the pointer stays at the furthest stage.
    const out: string[] = []
    for (const p of after.projects) {
      const st = STAGES.map((s) => byId(after.stages, `${p.id}/${s}`)).filter(Boolean)
      const furthest = st.findLastIndex((s: S) => s.state !== 'NOT_STARTED')
      const at = STAGES.indexOf(p.stage)
      if (at < furthest) out.push(`${p.id} points at ${p.stage}, ${STAGES[furthest]} already started`)
      if (at > furthest + 1) out.push(`${p.id} points at ${p.stage} beyond ${STAGES[furthest]}`)
      if (at === furthest + 1 && st[furthest]?.state !== 'PASSED')
        out.push(`${p.id} points past unpassed ${STAGES[furthest]}`)
    }
    return out
  },

  'gate-signatures-are-complete': ({ after }) => {
    const out: string[] = []
    for (const g of after.gates) {
      const roles = (g.signatures ?? []).map((s: S) => s.role)
      if (new Set(roles).size !== roles.length) out.push(`${g.id} signed twice by one role`)
      if (roles.some((r: string) => !g.approverRoles.includes(r)))
        out.push(`${g.id} signed by a role it does not name`)
      if (g.decision === 'REJECTED' && !g.comment) out.push(`${g.id} rejected without a comment`)
      if (g.decision === 'APPROVED' && g.findings.some((f: S) => !f.closed))
        out.push(`${g.id} approved with open findings`)
      if (
        g.decision === 'APPROVED' &&
        !g.superseded &&
        !g.auto &&
        g.approverRoles.some((r: string) => !roles.includes(r))
      )
        out.push(`${g.id} approved without every role`)
    }
    return out
  },

  'tr5-and-adcp-are-never-approved-with-an-open-class-a-defect': ({ before, after }) => {
    if (!before) return []
    const out: string[] = []
    for (const g of after.gates) {
      if (
        !['TR5', 'ADCP'].includes(g.code) ||
        g.decision !== 'APPROVED' ||
        byId(before.gates, g.id)?.decision === 'APPROVED'
      )
        continue
      const projectId = g.stageId.split('/')[0]
      const open = after.defects.filter(
        (d: S) => d.projectId === projectId && d.severity === 'A' && d.state !== 'CLOSED',
      )
      if (open.length) out.push(`${g.id} approved with open class-A ${open.map((d: S) => d.id).join(',')}`)
    }
    return out
  },

  'a-closed-defect-closes-its-gate-findings': ({ after }) => {
    const out: string[] = []
    for (const g of after.gates.filter((x: S) => x.decision === 'PENDING'))
      for (const f of g.findings)
        if (f.defectId && !f.closed && byId(after.defects, f.defectId)?.state === 'CLOSED')
          out.push(`${g.id} ${f.id} still open for closed ${f.defectId}`)
    return out
  },

  'defects-follow-their-machine': ({ before, after }) => {
    const out: string[] = []
    for (const d of after.defects) {
      const old = before && byId(before.defects, d.id)
      if (old && !hop('defect', old.state, d.state)) out.push(`${d.id} moved ${old.state} -> ${d.state}`)
      if (Boolean(d.closedAt) !== (d.state === 'CLOSED'))
        out.push(`${d.id} ${d.state} with closedAt ${d.closedAt}`)
    }
    return out
  },

  'trials-follow-their-rules': ({ before, after, op }) => {
    const out: string[] = []
    for (const t of after.trials) {
      const old = before && byId(before.trials, t.id)
      if (old && !hop('trial', old.state, t.state)) out.push(`${t.id} moved ${old.state} -> ${t.state}`)
      if (['REPORTED', 'APPROVED'].includes(t.state) && (!t.reportNo || !t.result || t.result === 'PENDING'))
        out.push(`${t.id} ${t.state} without report number and result`)
      if (t.state === 'APPROVED') {
        if (
          old &&
          old.state !== 'APPROVED' &&
          !(op?.fn === 'actApproval' && approvedFlow(after, 'trial', t.id, 'TRIAL_REPORT'))
        )
          out.push(`${t.id} became APPROVED by ${op?.fn}`)
        const c = byId(after.changes, t.changeId)
        if (
          t.result === 'FAIL' &&
          (!c || !['APPROVED', 'IMPLEMENTED', 'CLOSED'].includes(c.state) || c.ccb?.decision === 'REJECTED')
        )
          out.push(`${t.id} APPROVED with a FAIL result and change ${c?.state}`)
      }
      if (t.changeId && !after.changes.some((c: S) => c.id === t.changeId && c.projectId === t.projectId))
        out.push(`${t.id} links missing change ${t.changeId}`)
    }
    return out
  },

  'problems-and-faults-follow-their-rules': ({ before, after, op }) => {
    const out: string[] = []
    for (const p of after.problems) {
      const old = before && byId(before.problems, p.id)
      if (old && !hop('problem', old.state, p.state)) out.push(`${p.id} moved ${old.state} -> ${p.state}`)
      if (['ACTION', 'VERIFYING', 'CLOSED'].includes(p.state) && !(p.rootCause && p.steps?.D4?.done))
        out.push(`${p.id} ${p.state} without root cause and D4`)
      if (p.state !== 'CLOSED') continue
      if (
        old &&
        old.state !== 'CLOSED' &&
        !(op?.fn === 'actApproval' && approvedFlow(after, 'problem', p.id, 'PROBLEM_CLOSE'))
      )
        out.push(`${p.id} became CLOSED by ${op?.fn}`)
      const c = byId(after.changes, p.changeId)
      if (!p.steps?.D8?.done) out.push(`${p.id} CLOSED without D8`)
      if (p.changeId ? c?.state !== 'CLOSED' || c.ccb?.decision === 'REJECTED' : !p.noChangeReason)
        out.push(`${p.id} CLOSED with change ${c?.state} and reason ${p.noChangeReason ?? 'none'}`)
    }
    for (const f of after.faults) {
      const old = before && byId(before.faults, f.id)
      if (old && !hop('fault', old.state, f.state)) out.push(`${f.id} moved ${old.state} -> ${f.state}`)
      if (f.problemId && !byId(after.problems, f.problemId)?.faultIds?.includes(f.id))
        out.push(`${f.id} names ${f.problemId} which does not list it`)
    }
    return out
  },

  'history-is-capped-and-keeps-the-move-into-the-current-state': ({ after }) => {
    const out: string[] = []
    for (const name of [
      'stages',
      'changes',
      'defects',
      'trials',
      'faults',
      'problems',
      'requirements',
      'tasks',
    ])
      for (const x of after[name]) {
        const h: S[] = x.history ?? []
        if (h.length > HISTORY_LIMIT) out.push(`${x.id} history has ${h.length} lines`)
        const last = h.findLast((e, i) => i > 0 && e.from !== e.to)
        if (last && last.to !== x.state) out.push(`${x.id} is ${x.state}, its last move went to ${last.to}`)
        if (h.length && !h.some((e) => e.to === x.state)) out.push(`${x.id} history never enters ${x.state}`)
      }
    return out
  },

  'approval-flows-are-well-formed-and-final-flows-never-change': ({ before, after }) => {
    const out: string[] = []
    for (const f of after.approvals) {
      const ids = f.nodes.map((n: S) => n.id)
      if (new Set(ids).size !== ids.length) out.push(`${f.id} has duplicate node ids`)
      const active = f.nodes.filter((n: S) => n.state === 'ACTIVE')
      if (f.state === 'RUNNING') {
        if (active.length !== 1 || f.nodes[f.current] !== active[0])
          out.push(`${f.id} RUNNING with ${active.length} ACTIVE node(s)`)
        if (
          f.nodes.some(
            (n: S, i: number) =>
              (i < f.current && n.state !== 'DONE') || (i > f.current && n.state !== 'WAITING'),
          )
        )
          out.push(`${f.id} nodes do not follow the current index ${f.current}`)
      } else if (active.length) out.push(`${f.id} ${f.state} with an ACTIVE node`)
      if (f.state === 'APPROVED' && f.nodes.some((n: S) => n.state !== 'DONE'))
        out.push(`${f.id} APPROVED with an unfinished node`)
      for (const n of f.nodes)
        if (n.signed.some((r: string) => !n.roles.includes(r)))
          out.push(`${f.id}/${n.id} signed by a foreign role`)
      const old = before && byId(before.approvals, f.id)
      if (old && old.state !== 'RUNNING' && !same(old, f))
        out.push(`${f.id} changed after it ended ${old.state}`)
    }
    return out
  },

  'maintained-baseline-is-not-ahead-of-the-designed-one': ({ after }) => {
    const out: string[] = []
    for (const b of after.configBaselines.filter((x: S) => x.type === 'AS_MAINTAINED'))
      for (const [item, rev] of Object.entries(b.revs))
        if (
          !after.configBaselines.some(
            (d: S) => d.projectId === b.projectId && d.type !== 'AS_MAINTAINED' && d.revs[item] === rev,
          )
        )
          out.push(`${b.id} has ${item} at ${rev} which no designed/built baseline holds`)
    return out
  },

  'hand-backs-are-bounded-and-a-dismissed-one-is-not-pending': ({ after, op }) => {
    const out: string[] = []
    if (after.handbacks.length > HANDBACK_LIMIT) out.push(`${after.handbacks.length} hand-backs kept`)
    if (op?.fn === 'dismissHandback' && pendingHandbacks(after).some((c: S) => c.id === op.args.id))
      out.push(`${op.args.id} still pending after dismiss`)
    return out
  },

  'a-baselined-deliverable-has-no-running-release-and-no-draft-version': ({ after }) => {
    const out: string[] = []
    for (const a of after.artifacts.filter((x: S) => x.status === 'BASELINED')) {
      if (flowsOf(after, 'artifact', a.id).some((f) => f.state === 'RUNNING'))
        out.push(`${a.id} BASELINED with a running release flow`)
      if (/^V0\./.test(a.version)) out.push(`${a.id} BASELINED at draft version ${a.version}`)
    }
    return out
  },

  'approval-timeouts-are-derived-never-stored': ({ after }) => {
    const out: string[] = []
    for (const f of after.approvals)
      if ('overdue' in f || f.nodes.some((n: S) => 'overdue' in n)) out.push(`${f.id} stores an overdue flag`)
    return out
  },

  'a-submitter-never-closes-a-system-finding-and-a-reject-sends-the-stage-to-rework': ({
    before,
    after,
    op,
  }) => {
    if (!before) return []
    const out: string[] = []
    for (const g of after.gates) {
      const old = byId(before.gates, g.id)
      if (!old) continue
      if (op?.fn === 'submitGate')
        for (const f of old.findings)
          if (f.by === '系统检查' && !f.closed && g.findings.find((x: S) => x.id === f.id)?.closed)
            out.push(`${g.id} ${f.id} system finding closed by a submission`)
      if (
        old.decision === 'PENDING' &&
        g.decision === 'REJECTED' &&
        byId(after.stages, g.stageId)?.state !== 'REWORK'
      )
        out.push(`${g.id} rejected but ${g.stageId} is ${byId(after.stages, g.stageId)?.state}`)
      // the authoring role of the stage can never sign
      for (const sig of (g.signatures ?? []).slice(old.signatures?.length ?? 0))
        if (sig.role === byId(after.stages, g.stageId)?.author)
          out.push(`${g.id} signed by the stage author ${sig.role}`)
    }
    return out
  },

  'a-new-gate-lists-the-requirement-defect-and-trial-findings-the-rules-name': ({ before, after, op }) => {
    if (!before || (op?.fn !== 'submitGate' && !(op?.fn === 'transition' && op.args.to === 'IN_REVIEW')))
      return []
    const out: string[] = []
    for (const g of after.gates.filter((x: S) => !byId(before.gates, x.id))) {
      const pid = g.stageId.split('/')[0]
      const sys = (g.findings as S[]).filter((f) => f.by === '系统检查')
      const stage = byId(after.stages, g.stageId)
      if (
        stage.stage === 'REQUIREMENTS' &&
        coverage(after, pid).cusSwr.pct !== 100 &&
        !sys.some((f) => f.text.includes('CUS→SWR'))
      )
        out.push(`${g.id} has no CUS→SWR coverage finding`)
      if (['TR5', 'ADCP'].includes(g.code))
        for (const d of after.defects.filter(
          (x: S) => x.projectId === pid && x.severity === 'A' && x.state !== 'CLOSED',
        ))
          if (!sys.some((f) => f.defectId === d.id)) out.push(`${g.id} has no finding for class-A ${d.id}`)
      const type = ({ TYPE: 'TYPE_TEST', FAI: 'FAI' } as S)[g.code]
      if (type)
        for (const t of after.trials
          .filter((x: S) => x.projectId === pid && x.type === type && x.state !== 'APPROVED')
          .slice(0, 30))
          if (!sys.some((f) => f.text.includes(t.id)))
            out.push(`${g.id} has no finding for open trial ${t.id}`)
    }
    return out
  },

  'activity-feed-and-hand-back-cards-stay-consistent': ({ before, after }) => {
    const out: string[] = []
    if (after.activity.length > ACTIVITY_LIMIT) out.push(`${after.activity.length} activity lines kept`)
    for (const a of after.activity)
      if (a.summary.length > SUMMARY_LIMIT) out.push(`${a.id} summary has ${a.summary.length} characters`)
    for (const c of after.handbacks) {
      if (!['OPEN', 'DISMISSED', 'FOLLOWED'].includes(c.state)) out.push(`${c.id} is ${c.state}`)
      if (
        before &&
        byId(before.handbacks, c.id)?.state !== 'OPEN' &&
        byId(before.handbacks, c.id) &&
        c.state === 'OPEN'
      )
        out.push(`${c.id} was reopened`)
    }
    return out
  },

  'read-never-writes': ({ store, heavy }) => {
    if (!heavy) return []
    const before = { ...store.counts }
    read(store, T0 + 1)
    return same(before, store.counts) ? [] : ['read wrote to the store']
  },

  'the-read-model-never-throws': ({ after, op, heavy }) => {
    if (!heavy) return []
    try {
      snapshot(after, (op?.now ?? T0) + 1)
      for (const p of after.projects) {
        snapshot(after, (op?.now ?? T0) + 1, p.id)
        const cov = coverage(after, p.id)
        for (const m of [cov.cusSys, cov.sysSwr, cov.swrTc, cov.cusSwr])
          if (m.pct !== null && !(m.pct >= 0 && m.pct <= 100 && (m.pct === 100) === !m.missing.length))
            return [`${p.id} coverage ${m.pct}% with ${m.missing.length} missing`]
      }
      for (const [type, list] of [
        ['gate', after.gates],
        ['change', after.changes],
        ['trial', after.trials],
        ['fault', after.faults],
        ['problem', after.problems],
        ['project', after.projects],
      ] as [string, S[]][])
        for (const x of [...list.slice(0, 2), ...list.slice(-3)])
          handoff(after, { type, id: x.id }, (op?.now ?? T0) + 1)
      return []
    } catch (e) {
      return [`snapshot threw ${(e as Error).message}`]
    }
  },
}
// Reported by the runner itself (they need the call, not just the state).
const ENGINE = [
  'persisted-state-round-trips',
  'only-domain-errors-escape',
  'a-refused-approval-action-leaves-the-flow-untouched',
  MUST,
]

// ── Generators ────────────────────────────────────────────────────────────────────────────────────
type G = { r: () => number; s: S; focus?: string }
const int = (g: G, n: number) => Math.floor(g.r() * n)
const pick = <T>(g: G, a: T[]): T => a[int(g, a.length)] as T
const chance = (g: G, p: number) => g.r() < p
const maybe = <T>(g: G, a: T[]): T | undefined => (a.length ? pick(g, a) : undefined)
const asRole = (role: string) => `${role} 测试员`
const proj = (g: G): S => {
  const f = g.focus && byId(g.s.projects, g.focus)
  return f && chance(g, 0.75) ? f : pick(g, g.s.projects)
}
const mine = (g: G, name: string, p: S): S[] => g.s[name].filter((x: S) => x.projectId === p.id)
const nextOf = (g: G, kind: string, state: string) =>
  chance(g, 0.9) ? maybe(g, (MACHINES as S)[kind][state] ?? []) : pick(g, Object.keys((MACHINES as S)[kind]))

type Gen = (g: G) => { fn: string; args: S; must?: string } | null | undefined | false
const GENS: [number, Gen][] = [
  // autopilot: agree at the current node of a running flow with a role it still awaits
  [
    14,
    (g) => {
      const flow = maybe(
        g,
        (g.s.approvals as S[]).filter((x) => x.state === 'RUNNING'),
      )
      if (!flow) return null
      const node = flow.nodes[flow.current]
      const roles: string[] =
        node.mode === 'ALL' ? node.roles.filter((r: string) => !node.signed.includes(r)) : node.roles
      return {
        fn: 'actApproval',
        args: { id: flow.id, action: 'APPROVE', by: asRole(pick(g, roles)), comment: '同意' },
        must: MUST,
      }
    },
  ],
  // autopilot: carry a change through analysis, CCB, ECN release, retrofit, verification and closing
  [
    10,
    (g) => {
      const p = proj(g)
      const c = maybe(
        g,
        mine(g, 'changes', p).filter((x) => x.state !== 'CLOSED'),
      )
      if (!c) return null
      const flows = g.s.approvals.filter((f: S) => f.subject.type === 'change' && f.subject.id === c.id)
      if (flows.some((f: S) => f.state === 'RUNNING')) return null
      const move = (to: string) => ({
        fn: 'transition',
        args: { kind: 'change', id: c.id, to, by: '技术负责人' },
      })
      const i = c.impact ?? {}
      const hasImpact = [i.reqs, i.artifacts, i.tests, i.items].some((l) => l?.length)
      const retro = c.retrofit && c.retrofit.done < c.retrofit.total
      switch (c.state) {
        case 'SUBMITTED': {
          const reqs = mine(g, 'reqs', p)
          if (!hasImpact || (!c.rootCause && ['FIELD', 'TYPE_TEST'].includes(c.source?.type)))
            return {
              fn: 'updateChange',
              args: {
                id: c.id,
                by: '系统设计师',
                rootCause: '根因',
                ...(hasImpact || !reqs.length ? {} : { impact: { reqs: [pick(g, reqs).id] } }),
              },
            }
          return move('ANALYZED')
        }
        case 'ANALYZED':
          return move('CCB_REVIEW')
        case 'CCB_REVIEW':
          return {
            fn: 'submitApproval',
            args: { template: 'ECR', subjectId: c.id, by: asRole('系统设计师') },
          }
        case 'REJECTED':
          return move('CLOSED')
        case 'APPROVED':
        case 'IMPLEMENTED': {
          if (c.ecn && !flows.some((f: S) => f.template === 'ECN_RELEASE' && f.state === 'APPROVED'))
            return {
              fn: 'submitApproval',
              args: { template: 'ECN_RELEASE', subjectId: c.id, by: asRole('配置管理员') },
            }
          if (retro && chance(g, 0.7))
            return {
              fn: 'transition',
              args: {
                kind: 'retrofit',
                id: c.id,
                done: c.retrofit.done + 1 + int(g, c.retrofit.total - c.retrofit.done),
                by: '质量工程师',
              },
            }
          if (c.verification?.result !== 'PASS')
            return {
              fn: 'updateChange',
              args: { id: c.id, by: '验证工程师', verification: { result: 'PASS' } },
            }
          return move(c.state === 'APPROVED' ? 'IMPLEMENTED' : 'CLOSED')
        }
        default:
          return null
      }
    },
  ],
  // autopilot: carry a quality problem through 8D to its closing flow
  [
    5,
    (g) => {
      const q = maybe(
        g,
        mine(g, 'problems', proj(g)).filter((x) => x.state !== 'CLOSED'),
      )
      if (!q || flowsOf(g.s, 'problem', q.id).some((f) => f.state === 'RUNNING')) return null
      const by = '质量工程师'
      switch (q.state) {
        case 'OPEN':
          return { fn: 'upsertProblem', args: { id: q.id, by, to: 'ANALYZING' } }
        case 'ANALYZING':
          return {
            fn: 'upsertProblem',
            args: { id: q.id, by, to: 'ACTION', rootCause: '根因', steps: { D4: { done: true } } },
          }
        case 'ACTION':
          return {
            fn: 'upsertProblem',
            args: {
              id: q.id,
              by,
              to: 'VERIFYING',
              steps: { D8: { done: true } },
              noChangeReason: '无需设计变更',
            },
          }
        default:
          return {
            fn: 'submitApproval',
            args: { template: 'PROBLEM_CLOSE', subjectId: q.id, by: asRole('质量工程师') },
          }
      }
    },
  ],
  // autopilot: carry a trial to a report and its report flow
  [
    5,
    (g) => {
      const t = maybe(
        g,
        mine(g, 'trials', proj(g)).filter((x) => x.state !== 'APPROVED'),
      )
      if (!t || flowsOf(g.s, 'trial', t.id).some((f) => f.state === 'RUNNING')) return null
      if (t.state === 'PLANNED')
        return { fn: 'upsertTrial', args: { id: t.id, to: 'IN_PROGRESS', by: '验证工程师' } }
      if (t.state === 'IN_PROGRESS')
        return {
          fn: 'upsertTrial',
          args: {
            id: t.id,
            to: 'REPORTED',
            reportNo: `R-${t.id}`,
            result: chance(g, 0.85) ? 'PASS' : 'FAIL',
            by: '验证工程师',
          },
        }
      return {
        fn: 'submitApproval',
        args: { template: 'TRIAL_REPORT', subjectId: t.id, by: asRole('验证工程师') },
      }
    },
  ],
  // autopilot: take the first unfinished stage of a project one step further, every role signing
  [
    12,
    (g) => {
      const p = proj(g)
      const st = mine(g, 'stages', p)
      const open = st.find((s) => s.state !== 'PASSED')
      if (!open) return null
      if (['NOT_STARTED', 'REWORK'].includes(open.state))
        return { fn: 'transition', args: { kind: 'stage', id: open.id, to: 'IN_PROGRESS', by: '研发协调员' } }
      if (open.state === 'IN_PROGRESS')
        return { fn: 'submitGate', args: { stageId: open.id, by: '研发协调员' } }
      const gate = g.s.gates.find((x: S) => x.stageId === open.id && x.decision === 'PENDING')
      const role = gate?.approverRoles.find(
        (r: string) => !(gate.signatures ?? []).some((x: S) => x.role === r),
      )
      return (
        role && {
          fn: 'decideGate',
          args: {
            gateId: gate.id,
            decision: 'APPROVED',
            by: asRole(role),
            comment: '同意',
            closeFindings: gate.findings
              .filter((f: S) => !f.closed)
              .map((f: S) => ({ id: f.id, note: '已核对' })),
          },
        }
      )
    },
  ],
  // many notes on one record push its history past the cap
  [
    4,
    (g) => {
      const pool = [...g.s.trials, ...g.s.problems, ...g.s.changes, ...g.s.defects].sort(
        (a: S, b: S) => b.history.length - a.history.length,
      )
      const x = chance(g, 0.7) ? pool[0] : maybe(g, pool)
      if (!x) return null
      const fn = x.id.startsWith('QP')
        ? 'upsertProblem'
        : x.id.startsWith('CR')
          ? 'updateChange'
          : x.id.startsWith('DEF')
            ? 'transition'
            : 'upsertTrial'
      if (fn === 'transition')
        return {
          fn,
          args: {
            kind: 'defect',
            id: x.id,
            to: nextOf(g, 'defect', x.state) ?? 'CONFIRMED',
            by: '软件设计师',
            note: `备注 ${int(g, 99)}`,
          },
        }
      return { fn, args: { id: x.id, note: `备注 ${int(g, 99)}`, by: '质量工程师' } }
    },
  ],
  // start (or restart) a stage, mostly the first one that can start
  [
    5,
    (g) => {
      const st = mine(g, 'stages', proj(g)).filter((s) => ['NOT_STARTED', 'REWORK'].includes(s.state))
      const s = chance(g, 0.85) ? st[0] : maybe(g, st)
      return (
        s && {
          fn: 'transition',
          args: {
            kind: 'stage',
            id: s.id,
            to: 'IN_PROGRESS',
            by: '研发协调员',
            ...(chance(g, 0.05) ? { author: pick(g, ROLES) } : {}),
          },
        }
      )
    },
  ],
  // submit a stage for review / add and close findings on the pending gate
  [
    7,
    (g) => {
      const s = maybe(
        g,
        mine(g, 'stages', proj(g)).filter((x) => ['IN_PROGRESS', 'IN_REVIEW'].includes(x.state)),
      )
      if (!s) return null
      if (chance(g, 0.15))
        return { fn: 'transition', args: { kind: 'stage', id: s.id, to: 'IN_REVIEW', by: '研发协调员' } }
      const gate = g.s.gates.find((x: S) => x.stageId === s.id && x.decision === 'PENDING')
      const open = (gate?.findings ?? []).filter((f: S) => !f.closed && f.by !== '系统检查')
      return {
        fn: 'submitGate',
        args: {
          stageId: s.id,
          by: '研发协调员',
          ...(chance(g, 0.15) ? { findings: ['人工评审意见'] } : {}),
          ...(open.length && chance(g, 0.6)
            ? { closeFindings: open.map((f: S) => ({ id: f.id, note: '已处理' })) }
            : {}),
        },
      }
    },
  ],
  // a role signs or rejects a pending gate
  [
    14,
    (g) => {
      const gates: S[] = g.s.gates.filter((x: S) => x.decision === 'PENDING')
      const focused = g.focus ? gates.filter((x) => x.stageId.startsWith(`${g.focus}/`)) : []
      const gate = chance(g, 0.7) && focused.length ? pick(g, focused) : maybe(g, gates)
      if (!gate) return null
      const todo = gate.approverRoles.filter(
        (r: string) => !(gate.signatures ?? []).some((s: S) => s.role === r),
      )
      const role = chance(g, 0.9) && todo.length ? pick(g, todo) : pick(g, ROLES)
      const open = gate.findings.filter((f: S) => !f.closed)
      const reject = chance(g, 0.12)
      return {
        fn: 'decideGate',
        args: {
          gateId: gate.id,
          decision: reject ? 'REJECTED' : 'APPROVED',
          by: asRole(role),
          comment: reject ? '不通过' : '同意',
          ...(open.length && chance(g, 0.85)
            ? { closeFindings: open.map((f: S) => ({ id: f.id, note: '已核对' })) }
            : {}),
          ...(chance(g, 0.3) ? { handback: false } : {}),
        },
      }
    },
  ],
  // requirement / trace upsert
  [
    6,
    (g) => {
      const p = proj(g)
      const reqs = mine(g, 'reqs', p)
      const level = pick(g, ['CUS', 'SYS', 'SWR', 'SWR', 'TC', 'TC', 'DES'])
      const parentLevel: S = { SYS: 'CUS', SWR: 'SYS', TC: 'SWR', DES: 'SWR' }
      const prefix = level === 'SWR' ? pick(g, ['SWR', 'MER', 'EER']) : level
      const id = `${prefix}-${String(900 + int(g, 12)).padStart(3, '0')}`
      const existing = reqs.find((r) => r.id === id)
      const parents = reqs.filter((r) => r.level === parentLevel[level])
      const item: S = { id, title: `条目 ${id}`, text: `内容 ${id}` }
      if (level !== 'CUS' && (!existing || chance(g, 0.4))) {
        if (!parents.length) return null
        item.parent = [pick(g, parents).id]
      }
      if (chance(g, 0.1)) item.status = pick(g, ['DRAFT', 'APPROVED', 'CHANGED', 'VERIFIED'])
      return { fn: 'upsertReqs', args: { projectId: p.id, by: '测试员', items: [item] } }
    },
  ],
  // move a test case under another SWR (a verified case under an SWR that is not verified yet)
  [
    4,
    (g) => {
      const p = proj(g)
      const reqs = mine(g, 'reqs', p)
      const swrs = reqs.filter((r) => r.level === 'SWR')
      const tcs = reqs.filter((r) => r.level === 'TC')
      const tc = maybe(g, chance(g, 0.8) ? tcs.filter((t) => t.status === 'VERIFIED') : tcs)
      const to = maybe(g, chance(g, 0.7) ? swrs.filter((r) => r.status !== 'VERIFIED') : swrs)
      return (
        tc &&
        to && {
          fn: 'upsertReqs',
          args: {
            projectId: p.id,
            by: '测试员',
            items: [
              {
                id: tc.id,
                parent: [to.id],
                ...(chance(g, 0.5) ? { status: pick(g, ['APPROVED', 'DRAFT']) } : {}),
              },
            ],
          },
        }
      )
    },
  ],
  // test record per case
  [
    6,
    (g) => {
      const p = proj(g)
      const tcs = mine(g, 'reqs', p).filter((r) => r.level === 'TC')
      if (!tcs.length) return null
      const chosen = [...new Set(Array.from({ length: 1 + int(g, 5) }, () => pick(g, tcs).id))]
      return {
        fn: 'recordTestRun',
        args: {
          projectId: p.id,
          level: 'SYSTEM',
          by: '验证工程师',
          results: chosen.map((tc) => ({ tc, status: chance(g, 0.7) ? 'pass' : pick(g, ['fail', 'skip']) })),
        },
      }
    },
  ],
  // register a deliverable of a live project
  [
    4,
    (g) => {
      const live = maybe(
        g,
        g.s.projects.filter((x: S) => x.live),
      )
      if (!live) return null
      const kind = pick(g, ['PLAN', 'SRS', 'SAD', 'TEST_PLAN', 'RELEASE_NOTE', 'TEST_REPORT'])
      return {
        fn: 'recordArtifact',
        args: {
          projectId: live.id,
          path: `${kind.toLowerCase()}.md`,
          kind,
          stage: pick(g, [...STAGES]),
          markdown: `# ${kind} v${int(g, 9)}`,
          ...(chance(g, 0.15) ? { version: `V0.${1 + int(g, 4)}` } : {}),
          ...(chance(g, 0.1) ? { authorRole: pick(g, ROLES) } : {}),
        },
      }
    },
  ],
  // draft a change
  [
    5,
    (g) => {
      const p = proj(g)
      const reqs = mine(g, 'reqs', p).map((r) => r.id)
      const tcs = mine(g, 'reqs', p)
        .filter((r) => r.level === 'TC')
        .map((r) => r.id)
      const arts = mine(g, 'artifacts', p).map((a) => a.id)
      const trial = maybe(g, mine(g, 'trials', p))
      const type = pick(g, ['FIELD', 'TYPE_TEST', 'CUSTOMER', 'INTERNAL'])
      const baselines = g.s.configBaselines.filter((b: S) => b.projectId === p.id)
      const revOf = (id: string) => baselines.findLast((b: S) => b.revs[id])?.revs[id] ?? 'A'
      const it = maybe(g, mine(g, 'items', p))
      return {
        fn: 'create',
        args: {
          kind: 'change',
          projectId: p.id,
          title: `变更 ${int(g, 99)}`,
          reason: '原因',
          by: pick(g, ROLES),
          source: type === 'TYPE_TEST' && trial ? { type, ref: trial.id } : { type },
          ...(chance(g, 0.7) ? { rootCause: '根因' } : {}),
          impact: {
            reqs: reqs.length ? [chance(g, 0.3) && tcs.length ? pick(g, tcs) : pick(g, reqs)] : [],
            artifacts: arts.length && chance(g, 0.5) ? [pick(g, arts)] : [],
            ...(it && chance(g, 0.5)
              ? { items: [{ itemId: it.id, fromRev: revOf(it.id), toRev: `R${int(g, 5)}` }] }
              : {}),
            ...(chance(g, 0.4) ? { fleet: { doors: 2 + int(g, 4) } } : {}),
          },
          ...(chance(g, 0.3) ? { retrofit: { total: 2 + int(g, 4) } } : {}),
        },
      }
    },
  ],
  [
    8,
    (g) => {
      const c = maybe(g, mine(g, 'changes', proj(g)))
      const to = c && nextOf(g, 'change', c.state)
      return (
        c &&
        to && { fn: 'transition', args: { kind: 'change', id: c.id, to, by: pick(g, ROLES), note: '流转' } }
      )
    },
  ],
  [
    5,
    (g) => {
      const c = maybe(g, g.s.changes as S[])
      if (!c) return null
      const a: S = { id: c.id, by: pick(g, ROLES) }
      if (chance(g, 0.4))
        a.impact = {
          reqs: mine(g, 'reqs', byId(g.s.projects, c.projectId))
            .slice(0, 2)
            .map((r) => r.id),
        }
      if (chance(g, 0.3)) a.rootCause = '补充根因'
      if (chance(g, 0.3)) a.retrofit = { total: 1 + int(g, 6) }
      if (chance(g, 0.3)) a.verification = { result: chance(g, 0.8) ? 'PASS' : 'FAIL' }
      if (chance(g, 0.2)) a.title = `改名 ${int(g, 9)}`
      if (chance(g, 0.1)) a.note = '备注'
      return { fn: 'updateChange', args: a }
    },
  ],
  // retrofit progress
  [
    5,
    (g) => {
      const c = maybe(
        g,
        (g.s.changes as S[]).filter((x) => x.retrofit),
      )
      return (
        c && {
          fn: 'transition',
          args: {
            kind: 'retrofit',
            id: c.id,
            done: c.retrofit.done + 1 + int(g, Math.max(1, c.retrofit.total - c.retrofit.done)),
            by: '质量工程师',
          },
        }
      )
    },
  ],
  [
    4,
    (g) => {
      const p = proj(g)
      const tc = maybe(
        g,
        mine(g, 'reqs', p).filter((r) => r.level === 'TC'),
      )
      return {
        fn: 'create',
        args: {
          kind: 'defect',
          projectId: p.id,
          title: `缺陷 ${int(g, 99)}`,
          severity: pick(g, ['A', 'A', 'B', 'C']),
          by: '验证工程师',
          ...(tc && chance(g, 0.4) ? { testCase: tc.id } : {}),
        },
      }
    },
  ],
  [
    5,
    (g) => {
      const d = maybe(
        g,
        (g.s.defects as S[]).filter(
          (x) => x.state !== 'CLOSED' && (!g.focus || chance(g, 0.5) || x.projectId === g.focus),
        ),
      )
      const to = d && nextOf(g, 'defect', d.state)
      return d && to && { fn: 'transition', args: { kind: 'defect', id: d.id, to, by: '软件设计师' } }
    },
  ],
  [
    3,
    (g) => ({
      fn: 'upsertTrial',
      args: {
        projectId: proj(g).id,
        type: pick(g, ['TYPE_TEST', 'FAI', 'ROUTINE', 'FAT']),
        title: '试验',
        standard: 'STD',
        sample: 'S1',
        lab: 'LAB',
        plannedAt: '2026-11-01',
        by: '验证工程师',
      },
    }),
  ],
  [
    7,
    (g) => {
      const t = maybe(g, g.s.trials as S[])
      if (!t) return null
      if (chance(g, 0.25))
        return {
          fn: 'upsertTrial',
          args: { id: t.id, title: `改 ${int(g, 9)}`, note: '改动', by: '验证工程师' },
        }
      const to = nextOf(g, 'trial', t.state)
      const c = maybe(
        g,
        (g.s.changes as S[]).filter((x) => x.projectId === t.projectId),
      )
      return (
        to && {
          fn: 'upsertTrial',
          args: {
            id: t.id,
            to,
            by: '验证工程师',
            ...(chance(g, 0.85) ? { reportNo: `R-${int(g, 99)}` } : {}),
            ...(chance(g, 0.85) ? { result: pick(g, ['PASS', 'PASS', 'FAIL', 'CONDITIONAL']) } : {}),
            ...(c && chance(g, 0.4) ? { changeId: c.id } : {}),
          },
        }
      )
    },
  ],
  [
    3,
    (g) => {
      const p = proj(g)
      const faults = mine(g, 'faults', p).filter((f) => !f.problemId)
      return {
        fn: 'upsertProblem',
        args: {
          projectId: p.id,
          title: '质量问题',
          severity: pick(g, ['A', 'B', 'C']),
          by: '质量工程师',
          ...(faults.length && chance(g, 0.6) ? { faultIds: [pick(g, faults).id] } : {}),
        },
      }
    },
  ],
  [
    7,
    (g) => {
      const q = maybe(g, g.s.problems as S[])
      if (!q) return null
      const c = maybe(
        g,
        (g.s.changes as S[]).filter((x) => x.projectId === q.projectId),
      )
      const a: S = { id: q.id, by: '质量工程师' }
      const to = chance(g, 0.75) ? nextOf(g, 'problem', q.state) : undefined
      if (to) a.to = to
      if (chance(g, 0.7)) a.rootCause = '根因'
      const steps: S = {}
      if (chance(g, 0.7)) steps.D4 = { done: true }
      if (chance(g, 0.7)) steps.D8 = { done: true }
      if (Object.keys(steps).length) a.steps = steps
      if (c && chance(g, 0.4)) a.changeId = c.id
      if (chance(g, 0.3)) a.noChangeReason = '无需设计变更'
      if (!to && chance(g, 0.3)) a.title = `改 ${int(g, 9)}`
      return { fn: 'upsertProblem', args: a }
    },
  ],
  [
    3,
    (g) => {
      const f = maybe(
        g,
        (g.s.faults as S[]).filter((x) => x.state !== 'CLOSED'),
      )
      const to = f && nextOf(g, 'fault', f.state)
      return f && to && { fn: 'transition', args: { kind: 'fault', id: f.id, to, by: '诊断工程师' } }
    },
  ],
  // start an approval flow, mostly on an object the template accepts
  [
    10,
    (g) => {
      const template = pick(g, [
        'DOC_RELEASE',
        'ECR',
        'ECN_RELEASE',
        'PROBLEM_CLOSE',
        'TRIAL_REPORT',
        'ECR',
        'TRIAL_REPORT',
      ])
      const pool: S[] = (
        {
          DOC_RELEASE: g.s.artifacts,
          ECR: g.s.changes,
          ECN_RELEASE: g.s.changes,
          PROBLEM_CLOSE: g.s.problems,
          TRIAL_REPORT: g.s.trials,
        } as S
      )[template]
      const ok = (x: S) =>
        (
          ({
            DOC_RELEASE: x.status !== 'BASELINED',
            ECR: x.state === 'CCB_REVIEW',
            ECN_RELEASE: x.ecn,
            PROBLEM_CLOSE: x.state === 'VERIFYING',
            TRIAL_REPORT: x.state === 'REPORTED',
          }) as S
        )[template]
      const good = pool.filter(ok)
      const subject = chance(g, 0.9) && good.length ? pick(g, good) : maybe(g, pool)
      return (
        subject && {
          fn: 'submitApproval',
          args: { template, subjectId: subject.id, by: asRole(pick(g, ROLES)) },
        }
      )
    },
  ],
  // act on a running flow, mostly with a role the current node names
  [
    24,
    (g) => {
      const flow = maybe(
        g,
        (g.s.approvals as S[]).filter((a) => a.state === 'RUNNING'),
      )
      if (!flow) return null
      const node = flow.nodes[flow.current]
      const role = chance(g, 0.92) ? pick(g, node.roles as string[]) : pick(g, ROLES)
      const action = pick(g, [
        'APPROVE',
        'APPROVE',
        'APPROVE',
        'APPROVE',
        'APPROVE',
        'APPROVE',
        'APPROVE',
        'COMMENT',
        'REJECT',
        'RETURN',
        'RETURN',
        'TRANSFER',
        'ADD_SIGN',
        'WITHDRAW',
      ])
      const a: S = {
        id: flow.id,
        action,
        by: action === 'WITHDRAW' ? flow.initiator.by : asRole(role),
        comment: '意见',
      }
      if (action === 'RETURN')
        a.to = pick(g, [
          'INITIATOR',
          ...flow.nodes.slice(0, flow.current).map((n: S) => n.id),
          flow.nodes[0].id,
        ])
      if (action === 'TRANSFER') a.to = '李四'
      if (action === 'ADD_SIGN') a.role = pick(g, ROLES)
      return { fn: 'actApproval', args: a }
    },
  ],
  [
    1,
    (g) =>
      g.s.projects.length < 8 && {
        fn: 'create',
        args: {
          kind: 'project',
          name: `项目 ${int(g, 99)}`,
          projectKind: pick(g, ['SOFTWARE', 'NEW_BUILD', 'RETROFIT']),
        },
      },
  ],
  [
    1,
    (g) => {
      const c = maybe(g, g.s.handbacks as S[])
      return c && { fn: 'dismissHandback', args: { id: c.id, by: '测试员' } }
    },
  ],
]
const pickGen = (ticket: number): Gen => {
  let seen = 0
  for (const [weight, gen] of GENS) {
    seen += weight
    if (ticket < seen) return gen
  }
  return () => null
}
const TOTAL_WEIGHT = GENS.reduce((n, [w]) => n + w, 0)

// ── Runner ────────────────────────────────────────────────────────────────────────────────────────
type Found = { invariant: string; message: string; log: Op[]; atSeed: boolean }
type Gen0 = { seed: number; steps: number; focus?: string }

/**
 * Applies ops (generated when `gen` is given, then recorded) through `update` on a fresh store and checks the
 * invariants after each call that succeeded. `only` restricts the checks to one invariant (used when shrinking).
 */
function replay(ops: Op[], gen?: Gen0, stats?: Record<string, number>, only?: string) {
  let n = 0
  const store = memoryStore()
  update(store, () => undefined, T0)
  const found: Found[] = []
  const log: Op[] = []
  const known = new Set<string>()
  let state = read(store, T0)
  const record = (invariant: string, message: string, atSeed = false, last?: Op) => {
    if (!found.some((f) => f.invariant === invariant && f.atSeed === atSeed))
      found.push({ invariant, message, log: last ? [...log, last] : [...log], atSeed })
  }
  const check = (c: Ctx, seedPhase: boolean) => {
    for (const [name, fn] of Object.entries(INVARIANTS)) {
      if (only && name !== only) continue
      for (const m of fn(c)) {
        const key = `${name}|${m}`
        if (seedPhase) known.add(key)
        if (!known.has(key)) record(name, m)
        else if (seedPhase) record(name, m, true)
      }
    }
  }
  check({ after: state, store, heavy: true }, true)
  const count = (k: string) => {
    if (stats) stats[k] = (stats[k] ?? 0) + 1
  }

  const step = (op: Op) => {
    const before = state
    const docsBefore = new Map([...store.rows].filter(([k]) => k.startsWith('devboard/doc/')))
    let post: S
    const tool = TOOLS[op.fn]?.(op.args)
    try {
      update(
        store,
        (s: S) => {
          // a refused action must leave its flow as it was (the discarded copy still shows what it did)
          const flow = op.fn === 'actApproval' ? byId(s.approvals, op.args.id) : undefined
          const was = flow && JSON.stringify(flow)
          try {
            return APPLY[op.fn]?.(s, structuredClone(op.args), op.now)
          } catch (e) {
            if (flow && was !== JSON.stringify(flow))
              record(
                'a-refused-approval-action-leaves-the-flow-untouched',
                `${op.args.id} changed by a refused ${op.args.action}`,
              )
            throw e
          } finally {
            post = s
          }
        },
        op.now,
        tool ? { tool, actor: '研发协调员', input: op.args } : undefined,
      )
    } catch (e) {
      if (!(e instanceof DomainError))
        record('only-domain-errors-escape', `${op.fn} threw ${(e as Error).name}: ${(e as Error).message}`)
      else if (op.must)
        record(op.must, `${op.args.id} ${op.args.action} by ${op.args.by} refused: ${e.message}`, false, op)
      count(`refused:${op.fn}`)
      return
    }
    log.push(op)
    count(op.fn)
    if (op.fn === 'transition') count(`transition:${op.args.kind}`)
    const heavy = !gen || ++n % 8 === 0
    state = post
    if (heavy) {
      // what was saved must load back as the in-memory state it came from
      state = read(store, op.now)
      for (const k of Object.keys(state))
        if (!['schema', 'revision'].includes(k) && !same(post[k], state[k]))
          record('persisted-state-round-trips', `${k} differs after save and load`)
    }
    check({ before, after: state, op, store, docsBefore, heavy }, false)
  }

  for (const op of ops) step(op)
  if (!gen) return { found, log }
  const summary = () => {
    for (const a of state.approvals) count(`flow:${a.template}:${a.state}`)
    for (const c of state.changes) count(`change:${c.state}`)
    for (const t of state.trials) count(`trial:${t.state}`)
    for (const q of state.problems) count(`problem:${q.state}`)
    for (const x of state.gates) count(`gate:${x.decision}`)
    for (const x of state.stages) count(`stage:${x.state}`)
    for (const x of state.defects) count(`defect:${x.state}`)
  }
  const r = mulberry32(gen.seed)
  for (let i = 0; i < gen.steps; i++) {
    const g: G = { r, s: state, focus: gen.focus }
    const made = pickGen(r() * TOTAL_WEIGHT)(g)
    if (!made) continue
    const op = { ...made, now: T0 + (ops.length + i + 2) * HOUR }
    step(op)
  }
  summary()
  return { found, log }
}

/** The same replay on plain state (no store): enough to shrink every invariant that does not read the store. */
function replayFast(ops: Op[], invariant: string) {
  let state: S = seed(T0)
  state.revision += 1
  const store = memoryStore()
  const check = INVARIANTS[invariant] as Check
  const known = new Set(check({ after: state, store, heavy: true }))
  for (const op of ops) {
    const next = structuredClone(state)
    try {
      APPLY[op.fn]?.(next, structuredClone(op.args), op.now)
    } catch {
      continue
    }
    next.revision += 1
    const msgs = check({ before: state, after: next, op, store, docsBefore: new Map(), heavy: true })
    state = next
    if (msgs.some((m) => !known.has(m))) return true
  }
  return false
}
const NEEDS_STORE = ['final-and-flow-locked-records-are-not-edited', 'read-never-writes']

/** Delta debugging: the smallest subsequence of `log` that still violates `invariant`. */
function shrink(log: Op[], invariant: string, message: string): Op[] {
  const slow = !INVARIANTS[invariant] || NEEDS_STORE.includes(invariant)
  const fires = (ops: Op[]) =>
    slow
      ? replay(ops, undefined, undefined, INVARIANTS[invariant] ? invariant : undefined).found.some(
          (f) => f.invariant === invariant && !f.atSeed && (invariant !== MUST || f.message === message),
        )
      : replayFast(ops, invariant)
  let cur = log
  let n = 2
  while (cur.length >= 2) {
    const size = Math.ceil(cur.length / n)
    let reduced = false
    for (let i = 0; i < cur.length && !reduced; i += size) {
      const rest = [...cur.slice(0, i), ...cur.slice(i + size)]
      if (fires(rest)) {
        cur = rest
        n = Math.max(n - 1, 2)
        reduced = true
      }
    }
    if (!reduced) {
      if (n >= cur.length) break
      n = Math.min(cur.length, n * 2)
    }
  }
  return cur
}

const boot = (projectKind: string): Op => ({
  fn: 'create',
  args: { kind: 'project', name: '新项目', projectKind },
  now: T0 + HOUR,
})
const CONFIGS: { name: string; boot: Op[]; seed: number; steps: number; focus?: string }[] = [
  ...[1, 2, 3].map((seed) => ({ name: `seed state #${seed}`, boot: [], seed, steps: 200 })),
  ...[11, 12].map((seed) => ({
    name: `fresh live SOFTWARE project #${seed}`,
    boot: [boot('SOFTWARE')],
    seed,
    steps: 200,
    focus: 'PRJ-2026-009',
  })),
  ...[21, 22].map((seed) => ({
    name: `fresh NEW_BUILD project #${seed}`,
    boot: [boot('NEW_BUILD')],
    seed,
    steps: 200,
    focus: 'PRJ-2026-009',
  })),
]

// FUZZ_SEEDS=60 npx vitest run ... adds that many more seeds per kind for a longer hunt.
for (let i = 0; i < Number(process.env.FUZZ_SEEDS ?? 0); i++) {
  const seed = 1000 + i
  CONFIGS.push({ name: `extra seed state #${seed}`, boot: [], seed, steps: 300 })
  CONFIGS.push({
    name: `extra live SOFTWARE project #${seed}`,
    boot: [boot('SOFTWARE')],
    seed,
    steps: 300,
    focus: 'PRJ-2026-009',
  })
  CONFIGS.push({
    name: `extra NEW_BUILD project #${seed}`,
    boot: [boot('NEW_BUILD')],
    seed,
    steps: 300,
    focus: 'PRJ-2026-009',
  })
  CONFIGS.push({
    name: `extra RETROFIT project #${seed}`,
    boot: [boot('RETROFIT')],
    seed,
    steps: 300,
    focus: 'PRJ-2026-009',
  })
}

let cache: { violations: Map<string, string[]>; stats: Record<string, number> } | undefined
function runAll() {
  if (cache) return cache
  const violations = new Map<string, string[]>()
  const stats: Record<string, number> = {}
  for (const cfg of CONFIGS) {
    const { found } = replay(cfg.boot, cfg, stats)
    for (const f of found) {
      const key = f.atSeed ? `seed:${f.invariant}` : f.invariant
      if (violations.has(key)) continue
      // a known violation carries its repro in KNOWN; only a new one is worth the shrinking time
      const minimal = f.atSeed || KNOWN[key] ? [] : shrink(f.log, f.invariant, f.message)
      violations.set(key, [
        f.message,
        f.atSeed
          ? 'already true of the untouched seed'
          : KNOWN[key]
            ? `[${cfg.name}] known, see KNOWN[${key}].repro`
            : `[${cfg.name}] minimal sequence (${minimal.length} call(s), seed state first):`,
        ...minimal.map((op) => `${op.fn}(${JSON.stringify(op.args)})`),
      ])
    }
  }
  // FUZZ_DEBUG=1 prints every violation with its shrunk call sequence, known ones included
  if (process.env.FUZZ_DEBUG)
    console.log(`VIOLATIONS\n${[...violations].map(([k, v]) => `## ${k}\n${v.join('\n')}`).join('\n')}`)
  cache = { violations, stats }
  return cache
}

// ── Cases ─────────────────────────────────────────────────────────────────────────────────────────
const withNow = (ops: Omit<Op, 'now'>[]): Op[] => ops.map((o, i) => ({ ...o, now: T0 + (i + 2) * HOUR }))

describe('devboard invariant fuzz', () => {
  it('reaches deep states, so the invariants are not vacuous', { timeout: 120_000 }, () => {
    const { stats } = runAll()
    for (const fn of Object.keys(APPLY)) expect(stats[fn] ?? 0, `${fn} never succeeded`).toBeGreaterThan(0)
    for (const k of [
      'flow:DOC_RELEASE:APPROVED',
      'flow:ECR:APPROVED',
      'flow:ECN_RELEASE:APPROVED',
      'flow:PROBLEM_CLOSE:APPROVED',
      'flow:TRIAL_REPORT:APPROVED',
      'transition:retrofit',
      'stage:PASSED',
      'stage:REWORK',
      'gate:REJECTED',
    ])
      expect(stats[k] ?? 0, `${k} never happened`).toBeGreaterThan(0)
  })

  for (const name of [...Object.keys(INVARIANTS), ...ENGINE]) {
    const body = () => expect(runAll().violations.get(name) ?? [], KNOWN[name]?.why ?? name).toEqual([])
    // Whether the walk reaches a listed violation depends on its path, which any domain change moves: the walk
    // fails only on violations nobody listed, and a listed one is tracked by its fixed repro below.
    if (KNOWN[name]) it.skip(`${name} (listed in KNOWN)`, body)
    else it(name, body)
  }

  for (const name of Object.keys(INVARIANTS)) {
    const body = () =>
      expect(runAll().violations.get(`seed:${name}`) ?? [], KNOWN[`seed:${name}`]?.why ?? name).toEqual([])
    if (KNOWN[`seed:${name}`]) it.fails(`the seed satisfies ${name}`, body)
    else it(`the seed satisfies ${name}`, body)
  }

  // Every known violation also has a shortest repro that does not depend on the seeds above.
  for (const [name, known] of Object.entries(KNOWN)) {
    if (!known.repro) continue
    it.fails(`repro of ${name}`, () => {
      const { found } = replay(withNow(known.repro as Omit<Op, 'now'>[]))
      expect(found.filter((f) => f.invariant === name && !f.atSeed).map((f) => f.message)).toEqual([])
    })
  }
})

// A record the domain accepted must stay actionable: the store caps one item at 56 KiB, and an item grown to
// that size by accepted calls (long comments, long notes) must still take its next legal step.
describe('the storage cap does not strand a record', () => {
  /** Fills the store with accepted calls until even a 1-character one is refused for size, then runs `last`. */
  const strand = (
    call: (s: S, size: number, now: number) => unknown,
    last: (s: S, now: number) => unknown,
  ) => {
    const fresh = memoryStore()
    update(fresh, () => undefined, T0)
    update(fresh, (s: S) => last(s, T0 + 1000), T0 + 1000) // the closing call is legal on its own
    const store = memoryStore()
    update(store, () => undefined, T0)
    let at = T0
    for (const size of [2000, 500, 100, 20, 5, 1])
      for (;;) {
        try {
          at += 1000
          update(store, (s: S) => call(s, size, at), at)
        } catch (e) {
          expect((e as Error).message).toContain('单条数据过大')
          break
        }
      }
    update(store, (s: S) => last(s, at + 1000), at + 1000)
  }

  // domain.mjs act() logs every action, so the seeded flow AP-2026-0027 outgrows its chunk and refuses even APPROVE
  it.fails('a running flow filled with comments can still be agreed at its node', () =>
    strand(
      (s, size, now) =>
        actApproval(
          s,
          { id: 'AP-2026-0027', action: 'COMMENT', by: '任何人', comment: 'x'.repeat(size) },
          now,
        ),
      (s, now) => actApproval(s, { id: 'AP-2026-0027', action: 'APPROVE', by: '质量工程师 乙' }, now),
    ))

  // record() trims a history only past 30 lines; 28 long notes already fill the trial item and a move adds a line
  it.fails('a trial filled with notes can still make its next move', () =>
    strand(
      (s, size, now) => upsertTrial(s, { id: 'TT-2026-017', note: 'y'.repeat(size), by: '验证工程师' }, now),
      (s, now) => upsertTrial(s, { id: 'TT-2026-017', to: 'IN_PROGRESS', by: '验证工程师' }, now),
    ))
})

describe('an ECN release is never stranded', () => {
  // Two changes drafted against the same item revision: once the first ECN is released the second one is refused
  // when its release is started, so no flow is left waiting on a node nobody can agree.
  const draft = (title: string, toRev: string) => ({
    fn: 'create',
    args: {
      kind: 'change',
      projectId: 'PRJ-2023-011',
      title,
      reason: '原因',
      by: '系统设计师',
      impact: { reqs: [], artifacts: [], items: [{ itemId: 'NC-DR-1203', fromRev: 'B', toRev }] },
    },
  })
  const toCcb = (id: string) =>
    ['ANALYZED', 'CCB_REVIEW'].map((to) => ({
      fn: 'transition',
      args: { kind: 'change', id, to, by: '系统设计师' },
    }))
  const ecr = (id: string, flow: string) => [
    { fn: 'submitApproval', args: { template: 'ECR', subjectId: id, by: '系统设计师 甲' } },
    ...['机械设计师', '电气设计师', '软件设计师', '工艺工程师', '质量工程师', '技术负责人'].map((r) =>
      approve(flow, r),
    ),
  ]
  const release = (id: string, flow: string) => [
    { fn: 'submitApproval', args: { template: 'ECN_RELEASE', subjectId: id, by: '配置管理员 甲' } },
    ...['配置管理员', '分技术中心主任', '配置管理员'].map((r) => approve(flow, r)),
  ]
  it('refuses the second of two changes on one item before anyone signs its ECN release', () => {
    const ops = [
      draft('甲', 'C'),
      draft('乙', 'D'),
      ...toCcb('CR-2026-032'),
      ...toCcb('CR-2026-033'),
      ...ecr('CR-2026-032', 'AP-2026-0028'),
      ...ecr('CR-2026-033', 'AP-2026-0029'),
      ...release('CR-2026-032', 'AP-2026-0030'),
      {
        fn: 'submitApproval',
        args: { template: 'ECN_RELEASE', subjectId: 'CR-2026-033', by: '配置管理员 甲' },
      },
    ]
    expect(
      replay(withNow(ops))
        .found.filter((f) => f.invariant === MUST)
        .map((f) => f.message),
    ).toEqual([])
  })
})
