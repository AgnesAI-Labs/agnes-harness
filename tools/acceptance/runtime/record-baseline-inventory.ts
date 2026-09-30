import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { buildInventory, IMPLEMENTATION_BASELINE, serializeInventory } from './inventory.js'

const args = process.argv.slice(2)
const baseline = flag('--baseline') ?? IMPLEMENTATION_BASELINE
const out = flag('--out')
const root = flag('--root') ?? repositoryRoot()
if (!out) throw new Error('--out is required')

const inventory = buildInventory(root, baseline)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, serializeInventory(inventory))

function flag(name: string): string | undefined {
  const index = args.indexOf(name)
  const value = index >= 0 ? args[index + 1] : undefined
  if (value?.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

function repositoryRoot(): string {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  if (result.status !== 0 || !result.stdout.trim()) throw new Error('cannot resolve the repository root')
  return result.stdout.trim()
}
