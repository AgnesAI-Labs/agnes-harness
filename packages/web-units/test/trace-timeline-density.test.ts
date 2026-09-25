import { describe, expect, it } from 'vitest'
import {
  buildTraceTimelineDensity,
  pickTraceTimelineDensityMember,
  type TraceTimelineDensityBar,
} from '../src/trace-timeline-density.js'

type Bar = TraceTimelineDensityBar & { title: string }

const bar = (key: string, lane: string, start: number, end = start): Bar => ({
  key,
  lane,
  domainStart: start,
  domainEnd: end,
  targetId: key,
  title: `Original ${key}`,
})

describe('trace timeline density', () => {
  it('keeps sparse bars and point markers individually addressable in input order', () => {
    const bars = [bar('a', 'input', 0), bar('b', 'model', 1, 5), bar('c', 'tool', 5)]
    const units = buildTraceTimelineDensity(bars)
    expect(units.map((item) => [item.kind, item.count, item.members[0]])).toEqual([
      ['bar', 1, bars[0]],
      ['bar', 1, bars[1]],
      ['bar', 1, bars[2]],
    ])
    expect(units.map((item) => item.key)).toEqual(['bar:a', 'bar:b', 'bar:c'])
    expect(units[0]?.domainStart).toBe(0)
    expect(units[0]?.domainEnd).toBe(0)
  })

  it('bounds thousands of bars across lanes while retaining every member and stable keys', () => {
    const lanes = ['input', 'model', 'tool'] as const
    const bars = Array.from({ length: 3000 }, (_, index) =>
      bar(`bar-${index}`, lanes[index % 3] ?? 'input', index, index + (index % 7 === 0 ? 6 : 0)),
    )
    const units = buildTraceTimelineDensity(bars, { selectedKey: 'bar-1500' })
    expect(units.length).toBeLessThanOrEqual(600)
    expect(units.some((item) => item.kind === 'cluster')).toBe(true)
    expect(units.map((item) => item.count).reduce((a, b) => a + b, 0)).toBe(bars.length)
    expect(units.flatMap((item) => item.members.map((member) => member.key)).sort()).toEqual(
      bars.map((member) => member.key).sort(),
    )
    expect(new Set(units.map((item) => item.key)).size).toBe(units.length)
    expect(units.map((item) => item.key)).toEqual(
      buildTraceTimelineDensity(bars, { selectedKey: 'bar-1500' }).map((item) => item.key),
    )
    for (const item of units) {
      expect(item.members.every((member) => member.lane === item.lane)).toBe(true)
      expect(item.domainStart).toBe(Math.min(...item.members.map((member) => member.domainStart)))
      expect(item.domainEnd).toBe(Math.max(...item.members.map((member) => member.domainEnd)))
    }
    expect(units.find((item) => item.members.some((member) => member.key === 'bar-1500'))).toMatchObject({
      kind: 'bar',
      count: 1,
      members: [bars[1500]],
    })
  })

  it('allocates most buckets to a crowded lane', () => {
    const bars = [
      ...Array.from({ length: 100 }, (_, index) => bar(`tool-${index}`, 'tool', index)),
      bar('input', 'input', 0),
    ]
    const units = buildTraceTimelineDensity(bars, { maxUnits: 11 })
    expect(units).toHaveLength(11)
    expect(units.filter((item) => item.lane === 'tool')).toHaveLength(10)
    expect(units.filter((item) => item.lane === 'input')).toHaveLength(1)
  })

  it('chooses the nearest original interval and then its center when intervals overlap', () => {
    const first = bar('first', 'tool', 0, 10)
    const second = bar('second', 'tool', 8, 12)
    const marker = bar('marker', 'tool', 12)
    const [cluster] = buildTraceTimelineDensity([first, second, marker], { maxUnits: 1 })
    if (!cluster) throw new Error('expected a cluster')
    expect(cluster.kind).toBe('cluster')
    expect(pickTraceTimelineDensityMember(cluster, 1)).toBe(first)
    expect(pickTraceTimelineDensityMember(cluster, 9)).toBe(second)
    expect(pickTraceTimelineDensityMember(cluster, 12)).toBe(marker)
    expect(pickTraceTimelineDensityMember(cluster, 100)).toBe(marker)
  })

  it('uses input order to break exact ties and rejects invalid geometry', () => {
    const first = bar('first', 'tool', 3)
    const second = bar('second', 'tool', 3)
    const [cluster] = buildTraceTimelineDensity([first, second], { maxUnits: 1 })
    if (!cluster) throw new Error('expected a cluster')
    expect(pickTraceTimelineDensityMember(cluster, 3)).toBe(first)
    expect(() => pickTraceTimelineDensityMember(cluster, Number.NaN)).toThrow(RangeError)
    expect(() => buildTraceTimelineDensity([first, first])).toThrow('duplicate timeline bar key')
    expect(() => buildTraceTimelineDensity([bar('bad', 'tool', 4, 2)])).toThrow(RangeError)
    expect(() => buildTraceTimelineDensity([bar('bad', 'tool', Number.NaN)])).toThrow(RangeError)
    expect(() => buildTraceTimelineDensity([first], { maxUnits: 0 })).toThrow(RangeError)
    expect(() =>
      buildTraceTimelineDensity([first, bar('other', 'model', 4), bar('third', 'input', 5)], { maxUnits: 2 }),
    ).toThrow('each lane')
  })
})
