import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHooksMap } from '../src/index.js'
import { renderCoverage, syncGeneratedFile } from './coverage.js'
import { BASE_TARGETS } from './emit-base.js'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const packagesDir = dirname(packageDir)

export function runGeneration(check: boolean): boolean {
  const version = (JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version: string })
    .version
  const outputs = [
    { path: join(packageDir, 'COVERAGE.md'), content: renderCoverage(loadHooksMap(), version) },
    ...BASE_TARGETS.map((target) => ({
      path: join(packagesDir, target.relPath),
      content: target.render(version),
    })),
  ]
  let clean = true
  for (const output of outputs) {
    if (syncGeneratedFile({ check, ...output })) continue
    clean = false
    console.error(`stale: ${output.path}`)
  }
  return clean
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url) && !runGeneration(process.argv.includes('--check')))
  process.exitCode = 1
