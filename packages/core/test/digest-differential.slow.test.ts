import { jcsWrite } from '@agnes/protocol'
import { expect, it } from 'vitest'
import * as node from '../src/request/sha256-node.js'
import * as portable from '../src/request/sha256-portable.js'

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
