import { existsSync, readFileSync } from 'node:fs'
import {
  DEFAULT_SOURCE_PROVIDER_ID,
  installedDir,
  sha256Hex,
  writePartialArchive,
  writeVerifiedArchive,
} from '../../src/runtime/source-snapshot.js'

function holdFetch(cacheDir: string, treeDigest: string, bytesFile: string): void {
  const bytes = readFileSync(bytesFile)
  writePartialArchive(
    cacheDir,
    treeDigest,
    bytes.subarray(0, Math.min(8, bytes.length)),
    DEFAULT_SOURCE_PROVIDER_ID,
  )
  process.stdout.write('READY\n')
  setInterval(() => undefined, 1000)
}

function recoverFetch(cacheDir: string, treeDigest: string, bytesFile: string): void {
  const bytes = readFileSync(bytesFile)
  writeVerifiedArchive(cacheDir, treeDigest, bytes, DEFAULT_SOURCE_PROVIDER_ID)
  if (existsSync(installedDir(cacheDir))) {
    process.stderr.write('installed package appeared\n')
    process.exitCode = 1
    return
  }
  process.stdout.write(`STAGED ${treeDigest} ${sha256Hex(bytes)}\n`)
}

const command = process.argv[2]
const cacheDir = process.argv[3]
const treeDigest = process.argv[4]
const bytesFile = process.argv[5]
if (
  command === 'hold-fetch' &&
  cacheDir !== undefined &&
  treeDigest !== undefined &&
  bytesFile !== undefined
) {
  holdFetch(cacheDir, treeDigest, bytesFile)
} else if (
  command === 'recover-fetch' &&
  cacheDir !== undefined &&
  treeDigest !== undefined &&
  bytesFile !== undefined
) {
  recoverFetch(cacheDir, treeDigest, bytesFile)
} else {
  process.stderr.write('unknown package source command\n')
  process.exitCode = 1
}
