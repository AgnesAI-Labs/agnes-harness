import type { TableHandle } from '@agnes/base'
import { expect, it } from 'vitest'

// The separator core joins a harness/entry cell's kind and id with, written as an escape because a
// literal one is invisible in a diff - which is how it got into a source file here once already.
const NUL = '\u0000'
const bytes = (...v: number[]): Uint8Array => new Uint8Array(v)

/**
 * What every TableHandle owes the seams in `@agnes/base`, run against each implementation in turn:
 * the durable `node:sqlite` handle the host builds, and the `MemTable` the testkit hands a seam
 * under test. Every expectation below is written once, here, and neither implementation gets to
 * supply its own - a suite where each side states its own answer proves only that each side is
 * self-consistent, which is exactly the state a seam passes its tests in and loses rows in
 * production.
 *
 * `open` returns a fresh handle over a fresh, empty store.
 */
export function tableContract(name: string, open: () => TableHandle): void {
  const t = (): TableHandle => {
    const h = open()
    h.exec('create table t (k text, b blob, v integer)')
    return h
  }

  it(`${name}: inserts and reads back a row, with unlisted columns null`, () => {
    const h = t()
    expect(h.run('insert into t (k, v) values (?, ?)', ['a', 1])).toEqual({ changes: 1 })
    expect(h.all('select * from t')).toEqual([{ k: 'a', b: null, v: 1 }])
    expect(h.all('select v from t')).toEqual([{ v: 1 }])
    expect(h.get('select k from t')).toEqual({ k: 'a' })
  })

  it(`${name}: a statement naming a table that was never created fails`, () => {
    expect(() => t().all('select v from nope')).toThrow(/no such table/)
  })

  it(`${name}: two handles from the same store share their tables`, () => {
    const store = open()
    store.exec('create table shared (v integer)')
    store.run('insert into shared (v) values (?)', [4])
    // A second handle is a second name on one connection, not a second database.
    expect(store.all('select v from shared')).toEqual([{ v: 4 }])
  })

  // SQLite stores all bytes and can compare the bound value, but TEXT expressions containing NUL
  // have undefined semantics and node:sqlite returns only the prefix. Refusal is safer than a row
  // that appears to write successfully and later returns a different key. Callers needing arbitrary
  // bytes have the BLOB path pinned immediately below.
  it(`${name}: refuses a NUL in a TEXT bind before the statement changes a row`, () => {
    const h = t()
    const key = `a${NUL}b`
    expect(() => h.run('insert into t (k, v) values (?, ?)', [key, 1])).toThrow(
      /bind parameter 0 contains NUL/,
    )
    expect(h.all('select * from t')).toEqual([])
  })

  it(`${name}: the same key carried as bytes comes back whole`, () => {
    const h = t()
    const key = new TextEncoder().encode(`a${NUL}b`)
    h.run('insert into t (b, v) values (?, ?)', [key, 2])
    expect(h.all('select b from t')).toEqual([{ b: key }])
    // Bound as a fresh copy: a blob compares by value, not by identity.
    expect(h.all('select v from t where b = ?', [new TextEncoder().encode(`a${NUL}b`)])).toEqual([{ v: 2 }])
  })

  it(`${name}: = bound to null matches nothing, not even a null column`, () => {
    const h = t()
    h.run('insert into t (k, v) values (?, ?)', [null, 5])
    expect(h.all('select v from t where k = ?', [null])).toEqual([])
  })

  it(`${name}: ORDER BY sorts null, then numbers, then text, then blobs`, () => {
    const h = open()
    h.exec('create table o (v)')
    // Inserted in an order that shares nothing with the answer, so a comparator that gave up on
    // the class rank and left the rows where they were would not pass by luck.
    for (const v of [bytes(1), 'b', null, 'a', 2]) h.run('insert into o (v) values (?)', [v])
    expect(h.all('select v from o order by v')).toEqual([
      { v: null },
      { v: 2 },
      { v: 'a' },
      { v: 'b' },
      { v: bytes(1) },
    ])
    expect(h.all('select v from o order by v desc limit 2')).toEqual([{ v: bytes(1) }, { v: 'b' }])
  })

  it(`${name}: count(*) is 0 over no rows and sum is null, and LIMIT applies after the aggregate`, () => {
    const h = t()
    expect(h.all('select count(*) as n from t')).toEqual([{ n: 0 }])
    expect(h.all('select sum(v) as n from t')).toEqual([{ n: null }])
    h.run('insert into t (v) values (?)', [3])
    h.run('insert into t (v) values (?)', [4])
    expect(h.all('select count(*) as n from t')).toEqual([{ n: 2 }])
    expect(h.all('select sum(v) as n from t')).toEqual([{ n: 7 }])
    expect(h.all('select count(*) as n from t limit 0')).toEqual([])
    expect(h.all('select sum(v) as n from t where v = ?', [3])).toEqual([{ n: 3 }])
    expect(h.all('select sum(v) as n from t where v = ?', [99])).toEqual([{ n: null }])
  })

  it(`${name}: an unaliased aggregate is named after the expression that produced it`, () => {
    const h = t()
    h.run('insert into t (v) values (?)', [3])
    expect(h.all('select count(*) from t')).toEqual([{ 'count(*)': 1 }])
    expect(h.all('select sum(v) from t')).toEqual([{ 'sum(v)': 3 }])
  })

  it(`${name}: update and delete report how many rows they touched`, () => {
    const h = t()
    h.run('insert into t (k, v) values (?, ?)', ['a', 1])
    h.run('insert into t (k, v) values (?, ?)', ['a', 2])
    h.run('insert into t (k, v) values (?, ?)', ['z', 3])
    expect(h.run('update t set v = ? where k = ?', [9, 'a'])).toEqual({ changes: 2 })
    expect(h.all('select v from t order by v')).toEqual([{ v: 3 }, { v: 9 }, { v: 9 }])
    expect(h.run('delete from t where k = ?', ['a'])).toEqual({ changes: 2 })
    expect(h.run('delete from t where k = ?', ['nobody'])).toEqual({ changes: 0 })
    expect(h.all('select k from t')).toEqual([{ k: 'z' }])
  })

  it(`${name}: a WHERE of two equalities takes its parameters in order`, () => {
    const h = t()
    h.run('insert into t (k, v) values (?, ?)', ['a', 1])
    h.run('insert into t (k, v) values (?, ?)', ['a', 2])
    expect(h.all('select v from t where k = ? and v = ?', ['a', 2])).toEqual([{ v: 2 }])
  })

  it(`${name}: refuses a bind parameter SQLite cannot carry`, () => {
    expect(() => t().run('insert into t (k) values (?)', [{ nope: true }])).toThrow(/bind parameter 0/)
    expect(() => t().run('insert into t (k) values (?)', [true])).toThrow(/bind parameter 0/)
  })

  // Measured, not assumed, and the direction is the surprising one: binding too few parameters is
  // silent - the placeholders left over are NULL - while binding one too many is an error. A seam
  // that drops a parameter therefore writes a NULL row rather than failing, on either adapter.
  it(`${name}: an unbound placeholder is NULL, and one parameter too many is an error`, () => {
    const h = t()
    expect(h.run('insert into t (k, v) values (?, ?)', ['a'])).toEqual({ changes: 1 })
    expect(h.all('select * from t')).toEqual([{ k: 'a', b: null, v: null }])
    expect(h.all('select v from t where k = ?', [])).toEqual([])
    expect(() => h.run('insert into t (k, v) values (?, ?)', ['a', 1, 2])).toThrow(
      /column index out of range/,
    )
  })

  it(`${name}: a transaction that throws leaves nothing behind`, () => {
    const h = t()
    h.run('insert into t (v) values (?)', [1])
    expect(() =>
      h.transaction(() => {
        h.run('insert into t (v) values (?)', [2])
        throw new Error('nope')
      }),
    ).toThrow(/nope/)
    expect(h.all('select v from t')).toEqual([{ v: 1 }])
  })

  it(`${name}: a transaction that returns keeps its writes and its value`, () => {
    const h = t()
    expect(
      h.transaction(() => {
        h.run('insert into t (v) values (?)', [8])
        return 'done'
      }),
    ).toBe('done')
    expect(h.all('select v from t')).toEqual([{ v: 8 }])
  })

  it(`${name}: get of a query that matches nothing is undefined`, () => {
    expect(t().get('select v from t where v = ?', [123])).toBeUndefined()
  })
}
