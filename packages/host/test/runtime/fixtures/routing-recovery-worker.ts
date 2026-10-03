import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  type RoutingRecoverySeed,
  recoverRoutingSelection,
  routingProofDigest,
} from './routing-recovery-source.js'

const [mode, sourceFile, resultFile] = process.argv.slice(2)
if ((mode !== 'first' && mode !== 'recover') || !sourceFile || !resultFile)
  throw new Error('Invalid fixture arguments')
const source = JSON.parse(readFileSync(sourceFile, 'utf8')) as {
  seed: RoutingRecoverySeed
  code: string
  digest: string
}
const paths = [
  '../../../src/runtime/providers/routing.ts',
  '../../../../../examples/runtime-reference/src/providers/routing.ts',
  '../../../../extension-api/src/runtime/routing-authoring.ts',
]
const code = createHash('sha256')
for (const path of paths) code.update(readFileSync(fileURLToPath(new URL(path, import.meta.url))))
if (source.code !== code.digest('hex') || source.digest !== routingProofDigest(source.seed))
  throw new Error('Original implementation or source changed')
const send = (value: unknown) => process.send?.(value)
if (mode === 'first') {
  await recoverRoutingSelection(source.seed, async (proof) => {
    const fd = openSync(resultFile, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify(proof))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    send({ phase: 'selected', pid: process.pid, proof })
    await new Promise<void>(() => {})
  })
} else {
  const original = JSON.parse(readFileSync(resultFile, 'utf8')) as unknown
  const recovered = await recoverRoutingSelection(source.seed)
  if (routingProofDigest(original) !== routingProofDigest(recovered))
    throw new Error('Original selection changed')
  send({ phase: 'recovered', pid: process.pid, proof: recovered })
  process.disconnect?.()
}
