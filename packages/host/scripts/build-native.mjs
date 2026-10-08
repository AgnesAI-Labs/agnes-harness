#!/usr/bin/env node
// Compatibility entry: build infrastructure helpers, then the remaining computer-use helper.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin' && process.platform !== 'linux') {
  process.exit(0)
}

const here = dirname(fileURLToPath(import.meta.url))
execFileSync(
  process.execPath,
  [join(here, '../../host-infrastructure/scripts/build-native.mjs'), ...process.argv.slice(2)],
  { stdio: 'inherit' },
)
const nativeDir = join(here, '..', 'native')
const defaultOutputDir = join(here, '..', 'dist', 'native')
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--output-dir' || !isAbsolute(args[1])))
  throw new Error('Expected --output-dir with an absolute directory')
const outputDir = args[1] ? resolve(args[1]) : defaultOutputDir
mkdirSync(outputDir, { recursive: true })
const builds =
  process.platform === 'darwin'
    ? [
        [
          'macos-live-app-identity.c',
          'macos-live-app-identity',
          ['-framework', 'Security', '-framework', 'CoreFoundation'],
        ],
      ]
    : []
for (const [sourceName, outputName, libraries] of builds) {
  const source = join(nativeDir, sourceName)
  const output = join(outputDir, outputName)
  if (!existsSync(source)) {
    console.error(`build-native: missing source ${source}`)
    process.exit(1)
  }
  execFileSync('cc', ['-O2', '-Wall', '-Wextra', '-o', output, source, ...libraries], {
    stdio: 'inherit',
  })
}
