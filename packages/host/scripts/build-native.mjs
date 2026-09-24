#!/usr/bin/env node
// Compiles the macOS libproc process-identity helper (see
// packages/host/native/macos-process-identity.c) at build time. This is the package's one
// native-toolchain dependency: macOS exposes no readable /proc equivalent, so identifying a
// live PID's start time and boot instance requires libproc + sysctl, which only a C binary can
// call. No-op on every platform other than macOS — Linux's process-identity backend is pure JS
// reading /proc, and no other platform is wired up yet — so this script is safe to run
// unconditionally in any install/build pipeline regardless of host OS.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  process.exit(0)
}

const here = dirname(fileURLToPath(import.meta.url))
const nativeDir = join(here, '..', 'native')
const defaultOutputDir = join(here, '..', 'dist', 'native')
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--output-dir' || !isAbsolute(args[1])))
  throw new Error('Expected --output-dir with an absolute directory')
const outputDir = args[1] ? resolve(args[1]) : defaultOutputDir
mkdirSync(outputDir, { recursive: true })
const builds = [
  ['macos-process-identity.c', 'macos-process-identity', []],
  [
    'macos-live-app-identity.c',
    'macos-live-app-identity',
    ['-framework', 'Security', '-framework', 'CoreFoundation'],
  ],
]
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
