import { expect, it } from 'vitest'
import { readWorkbenchEvidence } from '../src/index.js'

it('accepts bounded evidence objects without granting arbitrary URL navigation', () => {
  const item = { name: 'Review report', kind: 'report', status: 'available', path: 'reports/review.html' }
  expect(readWorkbenchEvidence({ evidence: [item] })).toEqual([item])
  for (const path of ['javascript:alert(1)', 'https://example.com', 'bad\npath', ''])
    expect(readWorkbenchEvidence({ evidence: [{ ...item, path }] })).toEqual([])
  expect(
    readWorkbenchEvidence({ evidence: [{ ...item, kind: 'shell' }, { ...item, status: 'completed' }, item] }),
  ).toEqual([item])
  expect(readWorkbenchEvidence({ evidence: Array.from({ length: 100 }, () => item) })).toHaveLength(64)
  expect(readWorkbenchEvidence({ count: 20 })).toEqual([])
})
