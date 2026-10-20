import type { OwnedStore } from '@agnes/extension-api'
import type { Audit, Disposition, State } from './model.js'
import { seed } from './seed.js'

const collections = [
  'requirements',
  'tests',
  'ncrs',
  'ecrs',
  'zeroing',
  'parts',
  'baselines',
  'milestones',
] as const
type Head = Pick<State, 'schema' | 'revision' | 'rule'> & { campaigns: string[]; auditCount: number }
export function read(store?: OwnedStore): State {
  if (!store) throw new Error('档案存储不可用 / Profile store unavailable')
  return store.transaction(() => load(store))
}
function load(store: OwnedStore): State {
  const head = store.get('programme') as Head | undefined
  if (!head) return seed()
  if (
    head.schema !== 1 ||
    !Number.isSafeInteger(head.auditCount) ||
    head.auditCount < 0 ||
    head.auditCount > 2000 ||
    !Array.isArray(head.campaigns)
  )
    throw new Error('未知或损坏数据版本 / Unknown or corrupt state schema')
  const required = (key: string) => {
    const value = store.get(key)
    if (!Array.isArray(value)) throw new Error('项目记录缺失 / Programme record missing')
    return value
  }
  const rows = Object.fromEntries(collections.map((key) => [key, required(`programme/${key}`)]))
  const campaigns = head.campaigns.map((id) => {
    const value = store.get(`programme/campaign/${id}`)
    if (!value || typeof value !== 'object') throw new Error('试验记录缺失 / Campaign record missing')
    return value
  })
  const audit = Array.from({ length: Math.ceil(head.auditCount / 100) }, (_, i) =>
    required(`programme/audit/${i}`),
  ).flat()
  return { ...rows, schema: head.schema, revision: head.revision, rule: head.rule, campaigns, audit } as State
}
/** Atomically called by update: each collection/campaign/audit page stays under OwnedStore's 64 KiB value limit. */
export function persist(store: OwnedStore, state: State) {
  const set = (key: string, value: unknown) => {
    const data = JSON.parse(JSON.stringify(value))
    if (JSON.stringify(store.get(key)) !== JSON.stringify(data)) store.set(key, data)
  }
  for (const key of collections) set(`programme/${key}`, state[key])
  for (const campaign of state.campaigns) set(`programme/campaign/${campaign.id}`, campaign)
  for (let i = 0; i < state.audit.length; i += 100)
    set(`programme/audit/${i / 100}`, state.audit.slice(i, i + 100))
  set('programme', {
    schema: state.schema,
    revision: state.revision,
    rule: state.rule,
    campaigns: state.campaigns.map((c) => c.id),
    auditCount: state.audit.length,
  })
}
export function coverage(s: State) {
  return s.requirements.map((r) => ({
    ...r,
    orphan: r.id !== 'SYS-001' && (!r.parent || !s.requirements.some((p) => p.id === r.parent)),
    gap: !r.design.length
      ? 'missing-design'
      : !r.tests.length
        ? 'untested'
        : r.tests.some((id) => s.tests.find((t) => t.id === id)?.status !== 'passed')
          ? 'verification-open'
          : r.verified
            ? 'covered'
            : 'verification-open',
  }))
}
export function impact(s: State, id: string) {
  const ecr = s.ecrs.find((r) => r.id === id)
  if (!ecr) throw new Error('更改单不存在 / ECR not found')
  const selected = new Set(ecr.requirements)
  // Expand the changed subtree first. Ancestors then need re-verification without
  // treating their unrelated sibling subtrees as changed design.
  let changed = true
  while (changed) {
    changed = false
    for (const r of s.requirements)
      if (r.parent && selected.has(r.parent) && !selected.has(r.id)) {
        selected.add(r.id)
        changed = true
      }
  }
  changed = true
  while (changed) {
    changed = false
    for (const r of s.requirements)
      if (selected.has(r.id) && r.parent && !selected.has(r.parent)) {
        selected.add(r.parent)
        changed = true
      }
  }
  const affected = s.requirements.filter((r) => selected.has(r.id))
  const tests = [...new Set([...ecr.tests, ...affected.flatMap((r) => r.tests)])]
  return {
    ecr,
    requirements: affected.map((r) => r.id),
    interfaces: ecr.interfaces,
    tests,
    screeningRequired: s.rule.status === 'active' && ecr.lotChange && ecr.thermallyCycled,
    ruleVersion: s.rule.status === 'active' ? s.rule.version : null,
    ruleEvidence: s.rule.evidence,
  }
}
export function investigate(s: State) {
  const campaign = s.campaigns[0]!
  const exceedances = campaign.samples.filter((p) => p.current > p.limit)
  return {
    anomalyId: 'AN-027',
    campaign: campaign.id,
    configuration: campaign.configuration,
    lot: campaign.lot,
    unit: campaign.unit,
    peakA: Math.max(...campaign.samples.map((p) => p.current)),
    limitA: 1.8,
    windowMinutes: [66, 70],
    units: { current: 'A', temperature: '°C', pressure: 'Pa', time: 'min' },
    assessmentScope:
      'Only the current upper limit is assessed here. Temperature and pressure have no supplied acceptance limits; do not declare their tests passed. / 本结果只评估电流上限；未提供温度和真空度验收限值，不能判定其试验通过。',
    changeMeaning:
      'thermallyCycled is a design environmental exposure flag, not proof that a test was performed or passed. / thermallyCycled 是设计环境属性，不是试验已完成或通过的证据。',
    zeroingSummary: s.zeroing.map((item) => ({
      id: item.id,
      status: item.status,
      accepted: item.criteria.filter((criterion) => criterion.accepted).map((criterion) => criterion.id),
      missing: item.criteria.filter((criterion) => !criterion.accepted).map((criterion) => criterion.id),
    })),
    exceedances,
    relatedNcrs: s.ncrs
      .filter((r) => r.lot === campaign.lot)
      .map((r) => ({ id: r.id, signature: r.signature, evidence: r.evidence })),
    change: s.ecrs[0],
    hypothesis: {
      'zh-CN': '新批次焊点热疲劳导致间歇高阻，驱动闭环补偿引发电流尖峰。仅为候选机理；尚未完成失效分析。',
      en: 'Thermal fatigue of new-lot solder joints may cause intermittent resistance and driver-loop compensation spikes. Hypothesis only; failure analysis is incomplete.',
    },
    alternatives: [
      'current-probe artefact / 电流探头伪差',
      'control-loop instability / 控制环路不稳定',
      'connector fretting / 连接器微动磨损',
    ],
    reproduction: [
      'A/B old/new lot thermal cycling at −40/+85 °C / 新旧批次冷热循环对照',
      'Four-wire continuity plus calibrated current probe / 四线连续性与校准电流探头同步测量',
      'X-ray, cross-section and independent review / X 射线、切片与独立评审',
    ],
    evidence: [
      'TC-026/run-log/03:06Z',
      'TC-026/current/66-70min',
      'ECR-014/CCB-DEMO-20260918',
      'NCR-016',
      'NCR-017',
      'NCR-018',
    ],
  }
}
export function health(s: State) {
  const rows = coverage(s)
  return {
    revision: s.revision,
    total: rows.length,
    verified: rows.filter((r) => r.gap === 'covered').length,
    gaps: rows.filter((r) => r.gap !== 'covered' || r.orphan).length,
    ncrs: s.ncrs.filter((r) => r.status !== 'closed').length,
    ecrs: s.ecrs.filter((r) => r.status === 'review').length,
    zeroing: s.zeroing.filter((r) => r.status !== 'closed').length,
    openAnomalies: new Set(s.zeroing.filter((item) => item.status !== 'closed').map((item) => item.anomaly))
      .size,
    bySeverity: Object.fromEntries(
      ['critical', 'major', 'minor'].map((v) => [
        v,
        s.ncrs.filter((r) => r.severity === v && r.status !== 'closed').length,
      ]),
    ),
  }
}
export type DraftInput = {
  ncrId: string
  disposition: Disposition
  rationale: string
  expectedRevision: number
}
export type DecisionInput = {
  kind: 'mrb' | 'configuration' | 'rule' | 'zeroing'
  id: string
  expectedRevision: number
}
type Approval =
  | (NonNullable<import('@agnes/extension-api').ToolContext['approval']> & {
      signedMeaning?: string
      confirmationMode?: string
      admission?: NonNullable<Parameters<OwnedStore['transaction']>[1]>
    })
  | undefined
function update(
  store: OwnedStore | undefined,
  expected: number,
  action: string,
  subject: string,
  approval: Approval,
  mutate: (s: State) => void,
) {
  if (!store) throw new Error('档案存储不可用 / Profile store unavailable')
  return store.transaction(() => {
    const s = read(store)
    if (s.revision !== expected) throw new Error('数据已变化，请重新审阅 / Revision changed; review again')
    if (s.audit.length >= 2000) throw new Error('审计容量已满 / Audit capacity reached')
    mutate(s)
    s.revision++
    const audit: Audit = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      action,
      subject,
      approval: approval?.requestId ?? null,
      ...(approval ? { signer: approval.answeredBy.id } : {}),
      ...(approval ? { confirmationMode: approval.confirmationMode ?? 'manual' } : {}),
      ...(approval?.signedMeaning ? { signatureMeaning: approval.signedMeaning } : {}),
      revision: s.revision,
    }
    s.audit.push(audit)
    persist(store, s)
    return { revision: s.revision, audit }
  }, approval?.admission)
}
export function draft(store: OwnedStore | undefined, input: DraftInput) {
  return update(store, input.expectedRevision, 'mrb-draft', input.ncrId, undefined, (s) => {
    const ncr = s.ncrs.find((r) => r.id === input.ncrId)
    if (!ncr || !['open', 'review'].includes(ncr.status))
      throw new Error('NCR 不可编辑 / NCR is not editable')
    if (input.rationale.trim().length < 20)
      throw new Error('请提供证据与处置依据 / Evidence and rationale required')
    ncr.disposition = input.disposition
    ncr.rationale = input.rationale.trim()
    ncr.status = 'review'
  })
}
export function propose(store: OwnedStore | undefined, expected: number) {
  return update(store, expected, 'rule-propose', 'TVAC-LOT-001', undefined, (s) => {
    if (s.rule.status !== 'absent') throw new Error('候选已存在 / Candidate already exists')
    s.rule.status = 'review'
    s.rule.evidence = ['AN-027', 'ECR-014', 'NCR-016', 'NCR-017']
  })
}
export function decide(store: OwnedStore | undefined, input: DecisionInput, approval: Approval) {
  if (
    !approval?.requestId ||
    ['agent', 'system'].includes(approval.answeredBy.role) ||
    (approval.confirmationMode === 'auto-confirmed under full access' && !approval.admission)
  )
    throw new Error('必须通过宿主人工审批 / Host human approval required')
  return update(store, input.expectedRevision, `${input.kind}-approve`, input.id, approval, (s) => {
    if (input.kind === 'mrb') {
      const r = s.ncrs.find((r) => r.id === input.id)
      if (!r || r.status !== 'review' || !r.disposition || !r.rationale)
        throw new Error('先完成 MRB 草案 / Prepare MRB draft first')
      r.status = 'dispositioned'
      r.approvals.push(approval.requestId)
      // A disposition is not physical completion or flight release.
      for (const p of s.parts.filter((p) => p.lot === r.lot))
        p.status =
          r.disposition === 'use-as-is'
            ? 'concession-hold'
            : r.disposition === 'scrap'
              ? 'scrap-authorized'
              : r.disposition === 'return-to-supplier'
                ? 'return-authorized'
                : r.disposition === 'repair'
                  ? 'repair-hold'
                  : 'rework-hold'
      for (const b of s.baselines.filter((b) => b.units.includes(r.unit)))
        if (b.status !== 'superseded') b.status = 'hold'
      for (const req of s.requirements.filter((r) => impact(s, 'ECR-014').requirements.includes(r.id)))
        req.verified = false
    } else if (input.kind === 'configuration') {
      const r = s.ecrs.find((r) => r.id === input.id)
      if (!r || r.status !== 'review') throw new Error('更改不在评审状态 / ECR is not under review')
      const analysis = impact(s, r.id)
      if (analysis.screeningRequired && !r.tests.includes('VT-033')) r.tests.push('VT-033')
      if (analysis.screeningRequired && !s.tests.some((t) => t.id === 'VT-033'))
        s.tests.push({
          id: 'VT-033',
          title: { en: 'Additional lot TVAC screening', 'zh-CN': '批次追加热真空筛选' },
          status: 'pending',
          configuration: r.to,
          evidence: '',
        })
      r.status = 'approved'
      r.approvals.push(approval.requestId)
      for (const req of s.requirements.filter((r) => analysis.requirements.includes(r.id)))
        req.verified = false
      const b = s.baselines.find((b) => b.id === r.to)
      if (b) {
        b.status = 'verification-hold'
        b.source = r.id
      }
    } else if (input.kind === 'rule') {
      if (input.id !== 'TVAC-LOT-001' || s.rule.status !== 'review')
        throw new Error('没有待审候选 / No candidate under review')
      s.rule.status = 'active'
      s.rule.version = 1
      s.rule.approval = approval.requestId
    } else {
      const z = s.zeroing.find((z) => z.id === input.id)
      if (!z || z.status === 'closed' || z.criteria.some((c) => !c.accepted || !c.evidence.length))
        throw new Error('双五条证据不完整，不能归零 / Double-five evidence incomplete; closure refused')
      z.status = 'closed'
      z.closure = {
        decisionId: approval.requestId,
        signer: approval.answeredBy.id,
        confirmationMode: approval.confirmationMode ?? 'manual',
        ...(approval.signedMeaning ? { meaning: approval.signedMeaning } : {}),
        reviewedRevision: input.expectedRevision,
        subjectRevision: approval.subjectRevision,
      }
    }
  })
}
