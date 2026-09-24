import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from './repo.js'
import { findings, type ScanFinding, scanCalls, scanRepo } from './scan-paging.js'

// A ledger scan returns at most 500 rows and says nothing when it stops there. A call in package
// source or a testkit must either carry a limit it pages by (never above 500) or read one exact seq;
// anything else goes through core's scanPages/scanAll. The adapters refuse such a query at run time
// too; this catches it before it ships.
const root = repoRoot()
type Allowed = { file: string; call: string; reason: string }
const allowlist = JSON.parse(
  readFileSync(join(root, 'tools/guards/scan-paging-allowlist.json'), 'utf8'),
) as Allowed[]
const allowed = (f: ScanFinding) => allowlist.some((a) => a.file === f.file && a.call === f.call)

describe('scan paging guard: fixtures', () => {
  const rules = (text: string) => findings(text, 'x.ts').map((f) => f.rule)

  it('reports a scan with neither a limit nor a single seq', () => {
    expect(rules('await log.scan({ fromSeq: 1, toSeq: s.lastSeq, type: "tool/call" })')).toEqual([
      'unbounded',
    ])
    expect(rules('await log.scan({ toSeq: upto })')).toEqual(['unbounded'])
  })

  it('reports a literal limit above the page size, underscores and all', () => {
    expect(rules('log.scan({ fromSeq: 1, limit: 1_001 })')).toEqual(['limit-over-page'])
    expect(rules('log.scan({ fromSeq: 1, limit: 501 })')).toEqual(['limit-over-page'])
    expect(rules('log.scan({ fromSeq: 1, limit: 500 })')).toEqual([])
  })

  it('checks the object argument of the two-argument adapter form', () => {
    expect(rules('storage.scan(key, { toSeq: 9 })')).toEqual(['unbounded'])
    expect(rules('storage.scan(key, { toSeq: 9, limit: 10 })')).toEqual([])
    expect(rules('storage?.scan(key, { toSeq: 9 })')).toEqual(['unbounded'])
  })

  it('accepts a read of one exact seq, however the seq is spelled', () => {
    expect(
      rules(
        's.scan({ fromSeq: root.argsSeq ?? root.intentSeq, toSeq: root.argsSeq ?? root.intentSeq, lane })',
      ),
    ).toEqual([])
    expect(rules('s.scan({ fromSeq: seq, toSeq:  seq })')).toEqual([])
    expect(rules('s.scan({ fromSeq: a, toSeq: b })')).toEqual(['unbounded'])
  })

  it('reports a spread without a limit, which it cannot prove bounded', () => {
    expect(rules('s.scan({ ...range, fromSeq: x, toSeq: x })')).toEqual(['unbounded'])
    expect(rules('s.scan({ ...range, type: "t", limit: 1 })')).toEqual([])
  })

  it('does not look inside comments, strings, templates or regular expressions', () => {
    const text = [
      '// log.scan({ toSeq: 1 })',
      '/* log.scan({ toSeq: 1 }) */',
      "const a = 'log.scan({ toSeq: 1 })'",
      // Split so that no literal here contains a template placeholder of its own.
      ['const b = `log.scan({ toSeq: $', '{n} })`'].join(''),
      ['const c = `$', '{x}.scan({ toSeq: 1 })`'].join(''),
      'const d = /\\.scan\\(\\{/.test(s)',
      'const e = x / 2; log.scan({ toSeq: 1, limit: 2 })',
    ].join('\n')
    expect(rules(text)).toEqual([])
    expect(scanCalls(text)).toHaveLength(1)
  })

  it('leaves a query passed through by name to the run-time check', () => {
    expect(rules('return this.d.log.scan(q)')).toEqual([])
    expect(scanCalls('return this.d.log.scan(q)')).toHaveLength(1)
  })
})

describe('scan paging guard: repository', () => {
  const { calls, findings: found } = scanRepo(root)

  it('recognises the scan calls it is meant to check, rather than passing on an empty scan', () => {
    expect(calls).toBeGreaterThanOrEqual(60)
  })

  it('finds no unpaged ledger scan in package source or testkits outside the allowlist', () => {
    expect(found.filter((f) => !allowed(f))).toEqual([])
  })

  it('keeps no allowlist entry for a call that no longer exists or no longer needs one', () => {
    for (const a of allowlist) expect(a.reason.trim().length, `${a.file}: ${a.call}`).toBeGreaterThan(0)
    expect(allowlist.filter((a) => !found.some((f) => f.file === a.file && f.call === a.call))).toEqual([])
  })
})
