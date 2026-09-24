import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The three declaration tables this package publishes are readable as data but not as prose, and a
// hand-written page beside them would be a second source of truth that drifts. So the pages are
// rendered from the schema documents themselves and checked in, and `gen --check` fails when the
// checked-in copy no longer matches what the renderer produces.

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const load = (p: string) => JSON.parse(readFileSync(join(pkg, p), 'utf8')) as Record<string, unknown>

/** A one-line summary of a definition's field names, with optional ones marked by a trailing `?`. */
function fieldList(def: Record<string, unknown>): string {
  if (def.type === 'null') return '`void`'
  if (Array.isArray(def.oneOf)) return (def.oneOf as Record<string, unknown>[]).map(fieldList).join(' \\| ')
  const props = (def.properties ?? {}) as Record<string, unknown>
  const req = new Set((def.required as string[]) ?? [])
  return (
    Object.keys(props)
      .map((k) => (req.has(k) ? `\`${k}\`` : `\`${k}?\``))
      .join(', ') || '`{}`'
  )
}

export function renderHooksDoc(): string {
  const h = load('schema/hooks.json')
  const table = h['x-agnes-hook-table'] as Record<string, Record<string, unknown>>
  const io = h['x-agnes-hook-io'] as Record<string, [string, string]>
  const defs = h.$defs as Record<string, Record<string, unknown>>
  let md = '# HookMap\n\nGenerated from schema/hooks.json by tools/gen-docs.ts. Do not edit by hand.\n\n'
  md += '| event | mode | category | failPolicy | timeoutMs | replayOnResume |\n|---|---|---|---|---|---|\n'
  for (const [e, r] of Object.entries(table))
    md += `| \`${e}\` | ${r.mode} | ${r.category} | ${r.failPolicy} | ${r.timeoutMs} | ${r.replayOnResume ? 'yes' : 'no'} |\n`
  md += '\n## payload and return\n\n| event | payload | return |\n|---|---|---|\n'
  for (const [e, [p, r]] of Object.entries(io))
    md += `| \`${e}\` | ${fieldList(defs[p] as Record<string, unknown>)} | ${fieldList(defs[r] as Record<string, unknown>)} |\n`
  return md
}

export function renderSlotsDoc(): string {
  const s = load('schema/slots.json')
  const table = s['x-agnes-slot-table'] as Record<string, Record<string, unknown>>
  const defs = s.$defs as Record<string, Record<string, unknown>>
  let md = '# SlotMap\n\nGenerated from schema/slots.json by tools/gen-docs.ts. Do not edit by hand.\n\n'
  md += `One slot payload is capped at ${String(s['x-agnes-max-bytes'])} bytes. The cap is published here and enforced by the extension host and the UI projection, not by this package.\n\n`
  md +=
    '| slot | cardinality | order | surfaces | trigger | failPolicy | payload fields |\n|---|---|---|---|---|---|---|\n'
  for (const [slot, r] of Object.entries(table))
    md += `| \`${slot}\` | ${r.cardinality} | ${r.order} | ${(r.surfaces as string[]).join(' / ')} | ${(r.trigger as string[]).join(' / ')} | ${r.failPolicy} | ${fieldList(defs[r.payload as string] as Record<string, unknown>)} |\n`
  return md
}

export function renderToolsMetaDoc(): string {
  const t = load('schema/tooldef.json')
  const meta = (t.$defs as Record<string, unknown>).ToolMeta as Record<string, unknown>
  const props = meta.properties as Record<string, Record<string, unknown>>
  let md =
    '# ToolDef meta, the eight keys\n\nGenerated from schema/tooldef.json by tools/gen-docs.ts. Do not edit by hand.\n\n'
  md += '| key | shape | meaning and consumer |\n|---|---|---|\n'
  for (const k of Object.keys(props)) {
    const { description, ...shape } = props[k] as Record<string, unknown>
    md += `| \`${k}\` | \`${JSON.stringify(shape)}\` | ${String(description ?? '')} |\n`
  }
  return md
}

export function renderProjectionsDoc(): string {
  const defs = load('schema/projection.json').$defs as Record<string, Record<string, unknown>>
  return (
    '# Extension Projection declarations\n\nGenerated from schema/projection.json by tools/gen-docs.ts. Do not edit by hand.\n\n' +
    `Capability: ${fieldList(defs.ProjectionCapability as Record<string, unknown>)}.\n\n` +
    'Event types are exact and unique; wildcards are rejected. State and view are bounded to 262144 bytes. Manifest projection names must be distinct (validated by validateExtensionManifest).\n\n' +
    'Read results are available or unavailable. Unavailable results carry only a stable code and safe message. Owner and session are bound by Host, not supplied by Extension callers.\n'
  )
}

/** Writes the three pages, or counts how many are stale when `check` is set. */
export function writeDocs(check: boolean): number {
  const outDir = join(pkg, 'docs')
  const files: Array<[string, string]> = [
    ['hooks.md', renderHooksDoc()],
    ['slots.md', renderSlotsDoc()],
    ['tools-meta.md', renderToolsMetaDoc()],
    ['projections.md', renderProjectionsDoc()],
  ]
  let dirty = 0
  for (const [name, content] of files) {
    const p = join(outDir, name)
    const current = existsSync(p) ? readFileSync(p, 'utf8') : ''
    if (current === content) continue
    if (check) {
      console.error(`stale: docs/${name}`)
      dirty++
      continue
    }
    mkdirSync(outDir, { recursive: true })
    writeFileSync(p, content)
    console.log(`wrote docs/${name}`)
  }
  return dirty
}
