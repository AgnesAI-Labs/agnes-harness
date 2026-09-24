import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { checkToolDef, type ToolDef } from '@agnes/extension-api'

/**
 * Two assertions about a bundled extension, both of the same shape: something the extension says
 * about itself, checked against what its source actually does.
 *
 * These read files. That is the point of them living in testkit rather than in src: a tool reaches
 * a file system through its ToolContext because a tool runs inside a session that fences it, while
 * an assertion runs in a test process with no session and no fence, and what it is looking at is
 * the repository on disk.
 */

/** A tool definition the registry would accept, with the failure spelled out when it would not. */
export function expectToolMetaComplete(def: ToolDef, opts: { prefix?: string } = {}): void {
  const r = checkToolDef(def, opts)
  if (!r.ok) throw new Error(`${String((def as { name?: unknown }).name)}: ${r.problems.join('; ')}`)
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'gen', 'generated'])

function walk(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries.flatMap((e) => {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) return SKIP_DIRS.has(e) ? [] : walk(p)
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : []
  })
}

/** The resource kinds a manifest may grant. A `kind:` outside this set is some other object's. */
const RESOURCE_KINDS = ['skill', 'mcp', 'kb', 'datasource', 'model'] as const

export type UsedCapabilities = {
  hooks: Set<string>
  slots: Set<string>
  resources: Set<string>
  tools: Set<string>
  events: boolean
  /** Where a `registerResource` call was found whose `kind` is not a literal from the closed set. */
  opaqueResources: string[]
}

/**
 * What the source of one extension actually reaches for, read as text rather than by loading it.
 * Loading would need the extension's own dependencies and would only report what a particular run
 * happened to register; the declaration is a static claim, so it is checked statically.
 *
 * `registerResource` and `defineTool` are read by looking at the call site rather than by scanning
 * the whole file for a `kind:` or a `name:`. Both keys are ordinary words that appear all over
 * unrelated objects - a directory entry has a `kind`, every schema property has a `name` - and a
 * whole-file scan credited an extension with capabilities it never asked for.
 */
export function usedCapabilities(srcDir: string): UsedCapabilities {
  const out: UsedCapabilities = {
    hooks: new Set(),
    slots: new Set(),
    resources: new Set(),
    tools: new Set(),
    events: false,
    opaqueResources: [],
  }
  const near = (text: string, at: number): string => text.slice(at, at + 400)
  for (const file of walk(srcDir)) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/registerHook\(\s*['"]([A-Za-z0-9_]+)['"]/g)) out.hooks.add(m[1] as string)
    for (const m of text.matchAll(/registerSlot\(\s*['"]([A-Za-z0-9_.]+)['"]/g)) out.slots.add(m[1] as string)
    for (const m of text.matchAll(/registerResource\(/g)) {
      const kind = new RegExp(`kind:\\s*['"](${RESOURCE_KINDS.join('|')})['"]`).exec(
        near(text, m.index + m[0].length),
      )
      if (kind) out.resources.add(kind[1] as string)
      else out.opaqueResources.push(`${file}:${text.slice(0, m.index).split('\n').length}`)
    }
    for (const m of text.matchAll(/defineTool\(\s*\{/g)) {
      const name = /name:\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/.exec(near(text, m.index + m[0].length))
      if (name) out.tools.add(name[1] as string)
    }
    if (/\bevents\.append\(/.test(text)) out.events = true
  }
  return out
}

type ManifestCapabilities = {
  hooks?: string[]
  slots?: string[]
  resources?: string[]
  events?: boolean
  tools?: { prefix?: string; names?: string[] }
}

/**
 * The manifest of one extension against its own source. Declared-but-unused is reported for the
 * three list capabilities because an unused grant is authority nobody needs and nobody reviews;
 * `events` and the tool names are checked in one direction only, because registering fewer names
 * than a manifest allows is the safe direction - a name nobody registers is a name nobody calls.
 */
export function expectManifestMatchesCode(extDir: string): void {
  const manifest = JSON.parse(readFileSync(join(extDir, 'agnes.extension.json'), 'utf8')) as {
    capabilities?: ManifestCapabilities
  }
  const caps = manifest.capabilities ?? {}
  const used = usedCapabilities(join(extDir, 'src'))
  const problems: string[] = []

  const both = (what: string, declared: string[], u: Set<string>) => {
    for (const x of u) if (!declared.includes(x)) problems.push(`${what} used but not declared: ${x}`)
    for (const x of declared) if (!u.has(x)) problems.push(`${what} declared but unused: ${x}`)
  }
  both('hook', caps.hooks ?? [], used.hooks)
  both('slot', caps.slots ?? [], used.slots)
  both('resource', caps.resources ?? [], used.resources)

  for (const at of used.opaqueResources)
    problems.push(`registerResource with no literal kind cannot be checked: ${at}`)

  if (used.events && caps.events !== true)
    problems.push('events.append used but capabilities.events is not true')

  const prefix = caps.tools?.prefix ?? ''
  const names = caps.tools?.names
  for (const t of used.tools) {
    if (!t.startsWith(prefix)) problems.push(`tool ${t} does not carry the declared prefix ${prefix}`)
    // An absent `names` is an open set bounded by the prefix; a present one is closed.
    else if (names && !names.includes(t)) problems.push(`tool defined but not declared: ${t}`)
  }

  if (problems.length) throw new Error(`${extDir}: ${problems.join('; ')}`)
}
