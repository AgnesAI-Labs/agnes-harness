import { describe, expect, it } from 'vitest'
import { ChunkedMap, ChunkedSet } from '../src/reduce/chunked-map.js'

/** A small fixed-seed generator, so a failure replays the same operations. */
function seeded(seed: number): () => number {
  let x = seed
  return () => {
    x = (x * 48_271) % 2_147_483_647
    return x / 2_147_483_647
  }
}

describe('ChunkedMap', () => {
  it('behaves like a Map under thousands of random writes and reads', () => {
    const random = seeded(7)
    const plain = new Map<string, number>()
    let chunked = ChunkedMap.empty<string, number>()
    for (let i = 0; i < 5000; i++) {
      // Mostly new keys, so the map crosses many chunk boundaries; a fifth overwrite an earlier key.
      const key =
        random() < 0.2 && plain.size > 0 ? `k${Math.floor(random() * plain.size)}` : `k${plain.size}`
      plain.set(key, i)
      chunked = chunked.set(key, i)
      expect(chunked.size).toBe(plain.size)
      const probe = `k${Math.floor(random() * (plain.size + 10))}`
      expect(chunked.get(probe)).toBe(plain.get(probe))
      expect(chunked.has(probe)).toBe(plain.has(probe))
      if (i % 250 === 0) expect([...chunked]).toEqual([...plain])
    }
    expect([...chunked.entries()]).toEqual([...plain.entries()])
    expect([...chunked.keys()]).toEqual([...plain.keys()])
    expect([...chunked.values()]).toEqual([...plain.values()])
    const seen: [string, number][] = []
    chunked.forEach((value, key) => {
      seen.push([key, value])
    })
    expect(seen).toEqual([...plain])
  })

  it('never changes a map a later write was made from', () => {
    let current = ChunkedMap.empty<number, string>()
    const versions: { map: ChunkedMap<number, string>; entries: [number, string][] }[] = []
    for (let i = 0; i < 700; i++) {
      current = current.set(i % 600, `v${i}`)
      versions.push({ map: current, entries: [...current] })
    }
    for (const { map, entries } of versions) expect([...map]).toEqual(entries)
  })

  it('keeps an overwritten key where it was', () => {
    const map = ChunkedMap.empty<string, number>().set('a', 1).set('b', 2).set('a', 3)
    expect([...map]).toEqual([
      ['a', 3],
      ['b', 2],
    ])
  })

  it('builds the same map in one pass as by repeated writes, repeated keys included', () => {
    const entries: [string, number][] = []
    for (let i = 0; i < 1000; i++) entries.push([`k${i % 800}`, i])
    let one = ChunkedMap.empty<string, number>()
    for (const [key, value] of entries) one = one.set(key, value)
    const bulk = ChunkedMap.from(entries)
    expect([...bulk]).toEqual([...one])
    expect([...bulk]).toEqual([...new Map(entries)])
    expect(bulk.size).toBe(800)
  })
})

describe('ChunkedSet', () => {
  it('behaves like a Set and never changes a set a later add was made from', () => {
    const random = seeded(11)
    const plain = new Set<string>()
    let chunked = ChunkedSet.empty<string>()
    const versions: { set: ChunkedSet<string>; values: string[] }[] = []
    for (let i = 0; i < 2000; i++) {
      const value = `v${Math.floor(random() * 1500)}`
      plain.add(value)
      chunked = chunked.add(value)
      if (i % 100 === 0) versions.push({ set: chunked, values: [...chunked] })
      expect(chunked.size).toBe(plain.size)
      expect(chunked.has(value)).toBe(true)
    }
    expect([...chunked]).toEqual([...plain])
    expect([...chunked.entries()]).toEqual([...plain.entries()])
    expect([...ChunkedSet.from(plain)]).toEqual([...plain])
    for (const { set, values } of versions) expect([...set]).toEqual(values)
  })
})
