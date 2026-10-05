import type * as W from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { lockedMediaPlansMatch } from '../../src/runtime/media/locked.js'
import {
  digestOf,
  featuresImage,
  featuresText,
  mediaBinding,
  planOf,
  routeSnapshot,
} from './media-fixture.js'

const plan = planOf([{ marker: 1, node: 1 }], 'native')
const inline = (value: unknown): W.DataRef => ({
  kind: 'inline',
  schema: { typeId: 'agh.media/plan@1', revision: 1, digest: 'a'.repeat(64) },
  value: value as W.JsonValue,
  digest: digestOf(value),
  bytes: 1,
})
const handleOf = (...plans: unknown[]) => ({ header: { mediaPlanDigests: plans.map(digestOf) } }) as never
const target = { ...routeSnapshot(), features: featuresImage }
const forged = { ...plan, key: 'media:other' }
const widened = { ...plan, targetFeatures: { ...featuresImage, input: ['text', 'image', 'audio'] } }
const foreign = { ...plan, provider: { ...mediaBinding, contract: 'agh.model' } }

describe('lockedMediaPlansMatch', () => {
  it('accepts exactly the plans the handle header commits to, and none when it commits to none', () => {
    expect(lockedMediaPlansMatch(handleOf(plan), [inline(plan)], target)).toBe(true)
    expect(lockedMediaPlansMatch(handleOf(), [], target)).toBe(true)
  })
  it.each([
    ['a header commitment without an announced plan', handleOf(plan), [] as W.DataRef[], target],
    ['an announced plan the header does not commit to', handleOf(), [inline(plan)], target],
    ['an announced plan swapped for another one', handleOf(plan), [inline(forged)], target],
    [
      'an announcement whose own digest is forged',
      handleOf(plan),
      [{ ...inline(plan), digest: 'f'.repeat(64) } as W.DataRef],
      target,
    ],
    [
      'a header digest forged to match a forged announcement digest',
      { header: { mediaPlanDigests: ['f'.repeat(64)] } } as never,
      [{ ...inline(plan), digest: 'f'.repeat(64) } as W.DataRef],
      target,
    ],
    [
      'features wider than the locked target',
      handleOf(widened),
      [inline(widened)],
      { ...target, features: featuresText },
    ],
    ['a plan for another contract', handleOf(foreign), [inline(foreign)], target],
    [
      'a reference carrying the plan out of line',
      handleOf(plan),
      [{ kind: 'blob', blob: {} } as unknown as W.DataRef],
      target,
    ],
    ['a body that is not a plan', handleOf({ nope: 1 }), [inline({ nope: 1 })], target],
  ])('refuses %s', (_name, handle, refs, route) => {
    expect(lockedMediaPlansMatch(handle, refs, route as W.ModelRouteSnapshot)).toBe(false)
  })
})
