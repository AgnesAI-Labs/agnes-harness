import * as node from '@agnes/core-common/request/sha256-node'
import * as portable from '@agnes/core-common/request/sha256-portable'
import { jcs, jcsWrite } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { digestWith, values } from './helpers/digest-values.js'
import { jcsReference } from './helpers/jcs-reference.js'

it('agrees on a 200 MB string and the node path stays fast', () => {
  const value = { data: 'A'.repeat(200 * 1024 * 1024) }
  const started = performance.now()
  const n = node.createSha256()
  jcsWrite(value, (chunk) => n.update(chunk))
  const nodeDigest = n.digestHex()
  const nodeMs = performance.now() - started
  const p = portable.createSha256()
  jcsWrite(value, (chunk) => p.update(chunk))
  expect(nodeDigest).toBe(p.digestHex())
  // Generous bound for shared CI runners; the Mac acceptance harness measures the real number.
  expect(nodeMs).toBeLessThan(2_000)
}, 120_000)

it('agrees on 3000 generated values (ASCII, CJK, four-byte, empty, escapes, deep nesting, 70k strings)', () => {
  const gen = values(20261013)
  for (let i = 0; i < 3000; i++) {
    const value = gen.next().value
    const reference = jcsReference(value)
    expect(jcs(value)).toBe(reference)
    expect(digestWith(node, value)).toBe(digestWith(portable, value))
    expect(digestWith(node, value)).toBe(portable.sha256Hex(reference))
  }
}, 120_000)
