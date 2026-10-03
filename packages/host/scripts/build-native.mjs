#!/usr/bin/env node
// Builds standalone platform execution supervisors and macOS identity helpers.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
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
if (process.platform === 'win32') {
  if (process.arch !== 'x64') throw new Error('Windows execution qualification requires x64')
  const environment = { ...process.env }
  delete environment.CL
  execFileSync(
    process.env.AGNES_WINDOWS_CL ?? 'cl.exe',
    [
      '/nologo',
      '/EHsc',
      '/W4',
      '/WX',
      '/O2',
      '/std:c++17',
      '/utf-8',
      '/D_WIN32_WINNT=0x0A00',
      '/Fo' + join(outputDir, 'exec-governor.obj'),
      '/Fe' + join(outputDir, 'exec-governor.exe'),
      join(nativeDir, 'windows-exec-owner.cc'),
      '/link',
      'psapi.lib',
      'advapi32.lib',
    ],
    { env: environment, stdio: 'inherit', windowsHide: true },
  )
  process.exit(0)
}
const builds = [
  ['exec-governor.c', 'exec-governor', []],
  ...(process.platform === 'darwin'
    ? [
        ['macos-process-identity.c', 'macos-process-identity', []],
        [
          'macos-live-app-identity.c',
          'macos-live-app-identity',
          ['-framework', 'Security', '-framework', 'CoreFoundation'],
        ],
      ]
    : []),
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
