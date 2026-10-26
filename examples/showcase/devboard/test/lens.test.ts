import { describe, expect, it } from 'vitest'
import { COLLECTION, cardsOf, lensSummary, METRICS, relevant, waitingInterventions } from '../client/lens.js'
import { seed, snapshot } from '../domain.mjs'
import { ROLES } from '../profiles.mjs'

// biome-ignore lint/suspicious/noExplicitAny: the snapshot and lens.js are untyped plain data
type Any = any
const NOW = Date.parse('2026-10-21T08:00:00Z')
// The board snapshot of the buildSeed data, as the pages receive it (approvals carry waitingRoles).
const data: Any = snapshot(seed(NOW), NOW)
const mine = (role: string, kind: string): Any[] =>
  data[COLLECTION[kind as keyof typeof COLLECTION]].filter((x: Any) => relevant(role, kind, x, data))
const LIST_KINDS = ['req', 'task', 'change', 'defect', 'testRun', 'trial', 'fault', 'problem']

describe('role lens', () => {
  it.each(ROLES)('%s has a related list record or a non-zero home card', (role) => {
    const { counts } = lensSummary(role, data)
    const cards = cardsOf(role)
    expect(cards.length).toBeGreaterThanOrEqual(2)
    for (const key of cards) expect(METRICS, key).toHaveProperty(key)
    expect(
      LIST_KINDS.some((kind) => mine(role, kind).length > 0) || cards.some((key) => counts[key] > 0),
    ).toBe(true)
  })

  it('maps roles to their records', () => {
    expect(mine('质量工程师', 'defect')).toHaveLength(data.defects.length)
    const mech = mine('机械设计师', 'req')
    expect(mech.length).toBeGreaterThan(0)
    expect(mech.every((r) => r.discipline === 'MECH')).toBe(true)
    expect(mech.some((r) => r.discipline === 'SW')).toBe(false)
    expect(mine('配置管理员', 'configBaseline')).toHaveLength(data.configBaselines.length)
    const service = mine('客服工程师', 'fault')
    expect(service.length).toBeGreaterThan(0)
    expect(service.every((f) => f.source === '客服')).toBe(true)
    expect(mine('项目经理', 'task')).toHaveLength(data.tasks.length)
    expect(mine('工艺工程师', 'trial').every((t) => t.type === 'FAI')).toBe(true)
  })

  it('gives the default role, the project manager, something on every list page', () => {
    for (const kind of ['req', 'change', 'defect', 'trial', 'problem']) {
      const pm = mine('项目经理', kind)
      expect(pm.length, kind).toBeGreaterThan(0)
      expect(pm.length, kind).toBeLessThan(data[COLLECTION[kind as keyof typeof COLLECTION]].length)
    }
    expect(mine('项目经理', 'req').every((r) => r.status === 'CHANGED')).toBe(true)
    expect(
      mine('项目经理', 'defect').every((d) => ['A', 'B'].includes(d.severity) && d.state !== 'CLOSED'),
    ).toBe(true)
  })

  it('counts the open intervention requests that My to-dos lists, for every non-engineer role', () => {
    const open = data.interventions.filter((i: Any) => i.state === 'OPEN' || i.state === 'EXPIRED')
    expect(open.length).toBeGreaterThan(0)
    expect(waitingInterventions('技术负责人', data)).toEqual(open)
    expect(waitingInterventions('RAMS 工程师', data)).toEqual([])
    const lead = { ...data, gates: [], approvals: [] }
    expect(lensSummary('技术负责人', lead).pending).toBe(open.length)
    expect(lensSummary('RAMS 工程师', lead).pending).toBe(0)
  })

  it('matches whole roles, including the one that contains a space', () => {
    const handler = { handler: 'RAMS 工程师 唐力' }
    expect(relevant('RAMS 工程师', 'intervention', handler, data)).toBe(true)
    expect(relevant('软件设计师', 'intervention', { handler: '软件设计师长 林涛' }, data)).toBe(false)
    expect(relevant('质量工程师', 'defect', { owner: '软件设计师 林涛' }, data)).toBe(true)
    expect(relevant('软件设计师', 'defect', { owner: '软件设计师 林涛' }, data)).toBe(true)
    expect(relevant('电气设计师', 'defect', { owner: '软件设计师 林涛' }, data)).toBe(false)
  })

  it('counts everything waiting for a decision role as related', () => {
    const ccb = data.changes.filter((c: Any) => c.state === 'CCB_REVIEW')
    expect(ccb.length).toBeGreaterThan(0)
    for (const role of ['技术负责人', '分技术中心主任', 'IPMT'])
      for (const c of ccb) expect(relevant(role, 'change', c, data), `${role} ${c.id}`).toBe(true)
    const closed = data.changes.find(
      (c: Any) => c.state === 'CLOSED' && !String(c.raisedBy).startsWith('IPMT'),
    )
    expect(relevant('IPMT', 'change', closed, data)).toBe(false)
  })

  it('treats kinds and roles without a rule as not related', () => {
    const any = data.defects[0]
    for (const kind of ['banana', 'constructor', '__proto__', 'requirement', ''])
      expect(relevant('质量工程师', kind, any, data), kind).toBe(false)
    for (const role of ['', '访客', 'constructor', undefined])
      for (const kind of Object.keys(COLLECTION))
        expect(
          relevant(role as Any, kind, data[COLLECTION[kind as keyof typeof COLLECTION]][0], data),
          `${role} ${kind}`,
        ).toBe(false)
  })

  it('summarises what waits for a role and lists at most five urgent records, late first', () => {
    const quality = lensSummary('质量工程师', data)
    const waiting = data.approvals.filter(
      (a: Any) => a.state === 'RUNNING' && a.waitingRoles.includes('质量工程师'),
    )
    expect(waiting.length).toBeGreaterThan(0)
    expect(quality.pending).toBe(waiting.length)
    expect(quality.counts.defect).toBe(data.defects.filter((d: Any) => d.state !== 'CLOSED').length)
    expect(quality.urgent.length).toBeLessThanOrEqual(5)
    expect(quality.urgent[0].overdue).toBe(true)
    const flags = quality.urgent.map((u: Any) => u.overdue)
    expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)))
    expect(lensSummary('标准化工程师', data).urgent).toEqual([])
  })
})
