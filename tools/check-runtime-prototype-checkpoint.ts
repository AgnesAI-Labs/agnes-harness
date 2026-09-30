import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ARTIFACT_PATH,
  verifyPrototypeSnapshot,
  writePrototypeSnapshot,
} from './runtime-prototype/checkpoint.js'
import { compilePrototype } from './runtime-prototype/compile.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const flags = process.argv.slice(2)
try {
  if (flags.length > 1 || flags.some((flag) => flag !== '--write' && flag !== '--compile'))
    throw new Error('usage: check-runtime-prototype-checkpoint.ts [--write | --compile]')
  if (flags.includes('--compile')) {
    console.log(JSON.stringify(compilePrototype(root), null, 2))
  } else {
    const snapshot = flags.includes('--write')
      ? writePrototypeSnapshot(root)
      : verifyPrototypeSnapshot(root, JSON.parse(readFileSync(resolve(root, ARTIFACT_PATH), 'utf8')))
    console.log(
      JSON.stringify({
        checkpointId: snapshot.checkpointId,
        snapshotDigest: snapshot.snapshotDigest,
        result: 'pass',
      }),
    )
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'prototype checkpoint validation failed')
  process.exitCode = 1
}
