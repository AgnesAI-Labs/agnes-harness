import { annotations, expiryTime, markerLines } from '@agnes/protocol/memory-expiry'
import { expect, it } from 'vitest'
import {
  clearEntryExpiry,
  deleteEntry,
  memoryEntries,
  setEntryExpiry,
} from '../src/settings/memory-entries.js'

const stamp = '2028-02-29T00:30:04Z'
const ref = '<!-- ref:id -->'
const ttl = (date: string) => `<!-- expires_at: ${date} -->`

it('recognizes standalone annotations up to a whitespace-only line or EOF and parses UTC strictly', () => {
  const lines = [
    ttl('2028-02-29'),
    ttl('2028-02-30'),
    'body',
    ' \t',
    'prefix ' + ttl('2020'),
    ttl('invalid') + ' extra -->',
    ttl('2028-02-29T08:30:04+0800'),
  ]
  const source = lines.join('\r\n')
  expect([...annotations(source)]).toEqual([
    { start: 0, end: source.indexOf(' \t'), expiresAt: Date.UTC(2028, 1, 29) },
    { start: lines[0]!.length + 2, end: source.indexOf(' \t'), expiresAt: NaN },
    { start: source.lastIndexOf('<!--'), end: source.length, expiresAt: Date.parse(stamp) },
  ])
  expect(expiryTime('2028-02-29T00:30:04')).toBe(Date.parse(stamp))
})

it.each(['\n', '\r\n'])(
  'rewrites only the selected header and preserves every other character (%j)',
  (eol) => {
    const before = '\uFEFF🧪' + eol + ' \t' + eol
    const after = eol + eol + 'tail  ' + eol
    const body = '🧪 body' + eol + 'detail  '
    const source = before + [ttl('broken'), ref, ttl('2030'), body].join(eol) + after
    const entry = memoryEntries(source)[1]!
    expect(entry.preview).toBe('🧪 body')
    expect(setEntryExpiry(source, entry, stamp)).toBe(before + [ref, ttl(stamp), body].join(eol) + after)
    expect(clearEntryExpiry(source, entry)).toBe(before + ref + eol + body + after)
    expect(deleteEntry(source, entry)).toBe(before + 'tail  ' + eol)
    for (const invalid of ['2028-02-29', '2028-02-30T00:30:04Z', '2028-02-29T00:30:04.500Z'])
      expect(() => setEntryExpiry(source, entry, invalid)).toThrow()
    expect(() => deleteEntry('changed', entry)).toThrow()
    for (const ending of ['', eol]) {
      const text = '\uFEFFfirst' + eol + eol + body + ending
      expect(deleteEntry(text, memoryEntries(text)[1]!)).toBe('\uFEFFfirst' + ending)
      expect(deleteEntry(text, memoryEntries(text)[0]!)).toBe('\uFEFF' + body + ending)
    }
  },
)

it('leaves managed, malformed, marker-adjacent, fenced and partial-expiry regions to the Markdown editor', () => {
  const open = '<!-- refinement:ra000000001 -->'
  const close = '<!-- /refinement:ra000000001 -->'
  expect(markerLines('\uFEFF' + open + '\r\n' + ' <!-- / Refinement : ?')).toMatchObject([
    { start: 1, id: 'ra000000001', open: true },
    { open: false },
  ])
  for (const protectedText of [
    [ttl(stamp), open, 'first', '', 'second', close, 'adjacent'],
    [open, '<!-- /refinement:bad -->', '', 'inside', close],
    ['ordinary', '<!-- ReFiNeMeNt :bad -->', '', 'inside', '<!-- /refinement:bad -->'],
    [open, '<!-- refinement:rb000000001 -->', close, '', 'overlap', '<!-- /refinement:rb000000001 -->'],
    ['<!-- refinement:damaged -->', 'inside', '', open, 'managed', close],
    ['<!-- /refinement:stray -->', 'adjacent'],
    ['~~~md', 'a', '', 'b', '~~~'],
    ['- ~~~md', '  a', '', '  b', '  ~~~'],
    ['````', 'a', '```', '', 'b', '````'],
    ['visible', ttl(stamp), 'hidden'],
  ]) {
    const text = ['first', '', ...protectedText, '', 'last'].join('\n')
    expect(memoryEntries(text).map((entry) => entry.preview)).toEqual(['first', 'last'])
  }
  expect(memoryEntries(['~~~', '    ~~~', '', 'still inside'].join('\n'))).toEqual([])
  for (const opener of [open, '<!-- refinement:bad -->', '```js', '~~~~']) {
    expect(memoryEntries([opener, 'a', '', 'b'].join('\n'))).toEqual([])
  }
})
