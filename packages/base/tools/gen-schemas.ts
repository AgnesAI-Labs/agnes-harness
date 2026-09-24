import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOLS_CORE } from '../extensions/tools-core/src/index.js'
import { TOOLS_SEARCH } from '../extensions/tools-search/src/index.js'
import { TOOLS_WEB } from '../extensions/tools-web/src/index.js'

/**
 * Writes the on-disk copy of what the model is shown for each tool this package bundles: the
 * parameter schema of every tool, plus a hash over the names, descriptions and schemas together,
 * kept one hash per bundled extension so a change to one extension's tools does not move the other
 * extension's fixture.
 *
 * The point of keeping a copy is that these are a contract with the model, hashed into the prompt.
 * A change to any of them is a change to that contract, and it should appear in a diff rather than
 * be absorbed silently by whatever the code happens to say today.
 *
 * Checking is therefore the default and writing takes --write. A generator that rewrites by default
 * turns one accidental run into a refreshed snapshot, after which the snapshot can no longer notice
 * anything.
 */
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'tool-schemas')
const write = process.argv.includes('--write')
mkdirSync(dir, { recursive: true })

let stale = 0
function emit(file: string, content: string): void {
  const path = join(dir, file)
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return
  if (!write) {
    console.error(`stale: fixtures/tool-schemas/${file}`)
    stale++
    return
  }
  writeFileSync(path, content)
}

// Names, descriptions and schemas together, because all three reach the model and all three are
// what a provider hashes. The canonical form is the array in registration order, so a reordering is
// a change too - the order is what the model is shown. One hash per bundled extension, each in its
// own file, so a change to one extension's tools cannot silently move past the other's fixture.
function emitExtension(hashFile: string, tools: typeof TOOLS_CORE): void {
  for (const t of tools) emit(`${t.name}.json`, `${JSON.stringify(t.parameters, null, 2)}\n`)
  const canonical = JSON.stringify(
    tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
  )
  emit(hashFile, `${createHash('sha256').update(canonical).digest('hex')}\n`)
}

emitExtension('HASH', TOOLS_CORE)
emitExtension('HASH-tools-search', TOOLS_SEARCH)
emitExtension('HASH-tools-web', TOOLS_WEB)

if (stale > 0) {
  console.error(`${stale} tool schema snapshot(s) out of date; run: pnpm --filter @agnes/base gen`)
  process.exit(1)
}
