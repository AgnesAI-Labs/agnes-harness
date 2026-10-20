import type { OwnedStore, ToolContext } from '@agnes/extension-api'
import { DEMO_DATE, label, type Plant, SIGNATURE_MEANING } from './model.js'
import { batchOf, dossier, investigation } from './quality.js'
import { seed } from './seed.js'

export type Change = {
  action: 'review' | 'investigate' | 'advance'
  batch: string
  expectedRevision: number
  evidence?: string
}
export type Release = { batch: string; expectedRevision: number; meaning: string }
type Identity = {
  actor: string
  session: string | null
  approval?: ToolContext['approval'] & {
    signedMeaning?: string
    confirmationMode?: string
    admission?: NonNullable<Parameters<OwnedStore['transaction']>[1]>
  }
}
export function read(store?: OwnedStore): Plant {
  if (!store) throw new Error('Owner store unavailable / 业务存储不可用')
  const value = store.get('plant.header')
  if (value === undefined) return seed()
  const state = value as unknown as Pick<Plant, 'version' | 'revision'>
  if (state.version !== 1) throw new Error('Unsupported plant state / 不支持的数据版本')
  function rows<T>(family: string): T[] {
    const result: T[] = []
    let cursor: string | undefined
    do {
      const page = store!.scan({ prefix: `plant.${family}.`, limit: 256, ...(cursor ? { cursor } : {}) })
      for (const row of page.rows) result.push(...(row.value as unknown as T[]))
      cursor = page.nextCursor
    } while (cursor)
    return result
  }
  return {
    ...state,
    batches: rows('batches'),
    equipment: rows('equipment'),
    rooms: rows('rooms'),
    samples: rows('samples'),
    deviations: rows('deviations'),
    audit: rows('audit'),
  }
}
function persist(store: OwnedStore, p: Plant) {
  store.set('plant.header', { version: p.version, revision: p.revision })
  for (const family of ['batches', 'equipment', 'rooms', 'samples', 'deviations', 'audit'] as const) {
    const rows = p[family]
    for (let i = 0; i < rows.length; i += 4)
      store.set(
        `plant.${family}.${String(i).padStart(6, '0')}`,
        JSON.parse(JSON.stringify(rows.slice(i, i + 4))),
      )
  }
}

function write(
  store: OwnedStore | undefined,
  revision: number,
  identity: Identity,
  action: string,
  record: string,
  reason: string,
  mutate: (p: Plant) => void,
) {
  if (!store) throw new Error('Owner store unavailable / 业务存储不可用')
  return store.transaction(() => {
    const p = read(store)
    if (p.revision !== revision) throw new Error('Stale dossier; refresh and review / 档案已变化，请刷新复核')
    if (p.audit.length >= 2000) throw new Error('Demo audit capacity reached / 演示审计容量已满')
    mutate(p)
    p.revision++
    p.audit.push({
      id: `AUD-${String(p.revision).padStart(4, '0')}`,
      at: new Date().toISOString(),
      actor: identity.approval?.answeredBy.id ?? identity.actor,
      action,
      record,
      fromRevision: revision,
      toRevision: p.revision,
      reason,
      session: identity.session,
      approval: identity.approval?.requestId ?? null,
      ...(identity.approval ? { confirmationMode: identity.approval.confirmationMode ?? 'manual' } : {}),
      ...(identity.approval?.signedMeaning ? { signatureMeaning: identity.approval.signedMeaning } : {}),
    })
    persist(store, p)
    return p
  }, identity.approval?.admission)
}
export function change(store: OwnedStore | undefined, input: Change, who: Identity) {
  if (
    !who.approval ||
    ['agent', 'system'].includes(who.approval.answeredBy.role) ||
    (who.approval.confirmationMode === 'auto-confirmed under full access' && !who.approval.admission)
  )
    throw new Error('Human Host approval proof required / 需要宿主人工批准凭证')
  return write(
    store,
    input.expectedRevision,
    who,
    input.action,
    input.batch,
    input.evidence ?? 'Quality review / 质量复核',
    (p) => {
      const b = batchOf(p, input.batch)
      if (b.status === 'released') throw new Error('Released record is locked / 已放行记录锁定')
      const dev = p.deviations.find((d) => d.batch === b.id && d.stage !== 'closed')
      if (input.action === 'investigate') {
        if (!dev || dev.stage !== 'open') throw new Error('Deviation must be open / 偏差须处于待调查')
        const correlation = investigation(p, b.id)
        dev.stage = 'investigation'
        dev.impact = [b.id, ...correlation.relatedBatches]
        dev.cause =
          'Hypothesis: dryer probe drift; EM co-occurrence needs independent investigation / 假设：干燥探头漂移；EM 同期警戒需独立调查'
        dev.why = [
          'LOD high / LOD 偏高',
          'Endpoint indicated too early / 终点提前指示',
          'Probe T02 drift suspected / 怀疑 T02 漂移',
          'Calibration interval exceeded / 校准逾期',
          'Escalation not enforced / 逾期升级未落实',
        ]
        dev.actions = [
          {
            id: 'CAPA-017-1',
            text: label('更换探头并校准；追溯受影响批次', 'Replace/calibrate probe; assess affected batches'),
            owner: 'demo.engineer.qiu',
            due: '2024-10-21',
            evidence: '',
            effective: false,
          },
          {
            id: 'CAPA-017-2',
            text: label(
              '批准返工方案、独立复验和连续三批确认',
              'Approve reprocessing protocol, independent retest and three-batch verification',
            ),
            owner: 'demo.qa.su',
            due: '2024-10-23',
            evidence: '',
            effective: false,
          },
          {
            id: 'CAPA-017-3',
            text: label('EM 菌种鉴定、清洁和复采样', 'EM identification, cleaning and resampling'),
            owner: 'demo.micro.yao',
            due: '2024-10-22',
            evidence: '',
            effective: false,
          },
        ]
      } else if (input.action === 'advance') {
        // Explicit scenario evidence progression; no instrument/LIMS integration is claimed.
        if (b.id !== 'B-2410-017' || !dev || !['investigation', 'capa', 'effectiveness'].includes(dev.stage))
          throw new Error('No scenario transition / 无可用场景流转')
        if (!input.evidence?.trim() || input.evidence.trim().length < 12)
          throw new Error('Evidence reference and rationale required / 请输入证据编号及依据')
        if (dev.stage === 'investigation') {
          dev.stage = 'capa'
          dev.cause = `Confirmed in synthetic evidence: T02 as-found +4.1 °C drift; independent EM assessment remains pending / 合成证据确认 T02 漂移 +4.1 °C；EM 独立评估仍待完成。 Calibration evidence / 校准证据: CAPA-017-1`
          dev.why = dev.why.map((step) =>
            step.includes('drift suspected')
              ? `Probe T02 drift confirmed by synthetic as-found evidence / 合成 as-found 证据确认 T02 漂移: ${input.evidence}`
              : step,
          )
          const calibration = dev.actions.find((action) => action.id === 'CAPA-017-1')
          if (calibration)
            calibration.evidence = `CALIBRATION-ASFOUND [historical r${input.expectedRevision}→r${input.expectedRevision + 1}; EM status then only / 当时 EM 状态]:${input.evidence}`
        } else if (dev.stage === 'capa') {
          dev.stage = 'effectiveness'
          dev.cause = dev.cause
            .replace('independent EM assessment remains pending /', 'independent EM assessment completed /')
            .replace('EM 独立评估仍待完成。', 'EM 鉴别、清洁与复采样风险评估已完成。')
          const e = p.equipment.find((e) => e.id === 'DR-02')!
          e.calibrated = '2024-10-20'
          e.due = '2025-04-20'
          e.qualification = 'qualified'
          e.evidence.push(
            `CAL-ASLEFT-PASS:${dev.actions[0]?.evidence ?? input.evidence}`,
            `SUBSEQUENT-EM-ASSESSMENT [r${input.expectedRevision + 1}]:${input.evidence}`,
            ...dev.impact.map((id) => `RETROSPECTIVE:${id}:${dev.actions[0]?.evidence ?? input.evidence}`),
          )
          for (const action of dev.actions.filter((item) => ['CAPA-017-2', 'CAPA-017-3'].includes(item.id)))
            action.evidence = `${action.id === 'CAPA-017-2' ? 'REPROCESS-RETEST' : 'EM-ASSESSMENT'}:${input.evidence}`
          const original = b.steps.find((s) => s.id === 'drying')!.cpp[0]!
          b.retests.push({
            ...original,
            id: `RETEST-${original.id}`,
            value: 1.9,
            at: `${DEMO_DATE}T12:00:00Z`,
            source: `REPROCESS-PROTOCOL-017:${input.evidence}`,
          })
          p.samples
            .filter((s) => s.batch === b.id)
            .forEach((s) => {
              s.disposition = 'assessed'
              s.evidence = input.evidence!
            })
        } else {
          dev.actions.forEach((a) => {
            a.effective = true
            a.evidence += `; EFFECTIVENESS:${input.evidence}`
          })
          dev.stage = 'closed'
        }
      } else {
        b.review = 'accepted'
        const check = dossier(p, b.id)
        // Review acceptance only once every other release prerequisite is satisfied.
        if (!check.ready) b.review = 'findings'
      }
    },
  )
}
export function release(store: OwnedStore | undefined, input: Release, who: Identity) {
  if (
    !who.approval ||
    ['agent', 'system'].includes(who.approval.answeredBy.role) ||
    (who.approval.confirmationMode === 'auto-confirmed under full access' && !who.approval.admission)
  )
    throw new Error('Human Host approval proof required / 需要宿主人工批准凭证')
  if (input.meaning !== SIGNATURE_MEANING)
    throw new Error('Exact signature meaning required / 签名含义不匹配')
  return write(store, input.expectedRevision, who, 'release', input.batch, input.meaning, (p) => {
    const b = batchOf(p, input.batch),
      check = dossier(p, b.id)
    if (b.certificate || !check.ready)
      throw new Error('Release blocked by quality checklist / 质量清单阻止放行')
    b.status = 'released'
    b.certificate = {
      id: `REL-${b.id}-${p.revision}`,
      batch: b.id,
      at: new Date().toISOString(),
      signer: who.approval!.answeredBy.id,
      confirmationMode: who.approval!.confirmationMode ?? 'manual',
      meaning: who.approval!.signedMeaning ?? input.meaning,
      approvalId: who.approval!.requestId,
      subjectRevision: who.approval!.subjectRevision,
      dossierRevision: p.revision,
    }
  })
}
