import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  extractThemeTokenNames,
  renderHookTable,
  renderSlotTable,
  renderThemeTokenTable,
} from './gen-tables-core.js'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')
let dirty = false
function emit(name: string, text: string): void {
  const path = join(pkg, 'src', 'generated', name)
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return
  if (check) {
    console.error(`stale: ${name}`)
    dirty = true
  } else {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
}

for (const [source, field, name, render] of [
  ['hooks.json', 'x-agnes-hook-table', 'hook-table.ts', renderHookTable],
  ['slots.json', 'x-agnes-slot-table', 'slot-table.ts', renderSlotTable],
] as const) {
  const schema = JSON.parse(readFileSync(join(pkg, '..', 'protocol', 'schema', source), 'utf8'))
  emit(name, render(schema[field]))
}

// The theme-token whitelist comes from the Web client's own stylesheet rather than a protocol
// schema, so it is generated here directly: `style.css` stays the single colour authority.
const styleCss = readFileSync(join(pkg, '..', 'web', 'public', 'style.css'), 'utf8')
emit('theme-tokens.ts', renderThemeTokenTable(extractThemeTokenNames(styleCss)))

if (dirty) process.exitCode = 1
