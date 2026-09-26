import { createHash } from 'node:crypto'
import {
  type Disposer,
  defineExtension,
  defineTool,
  type ExtensionFactory,
  type Logger,
  type ToolDef,
} from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import type { SeamInitContext } from '../../../src/seam-init.js'
import { isSkillRelativePath } from './assets.js'

type SkillContextReturn = { sections?: Array<{ id: string; order: number; content: string }> }

export type SkillRuntimeActual = Readonly<{
  resourceId: string
  name: string
  description?: string
  revision: string
  sourceIdentity: Readonly<{ scope: string; rootKey: string; sourceId: string }>
  actual: 'ready' | 'disabled' | 'unavailable' | 'preparing' | 'degraded'
}>
export type SkillReadResult =
  | Readonly<{ ok: true; content: string; revision?: string; directory?: string }>
  | Readonly<{
      ok: false
      code: 'DISABLED' | 'UNTRUSTED_REVISION' | 'TRUST_REJECTED' | 'SHADOWED' | 'NOT_FOUND' | 'UNAUTHORIZED'
    }>
export type SkillFileReadResult =
  | Readonly<{ ok: true; content: string; mime: string }>
  | Readonly<{ ok: true; bytes: Uint8Array; mime: string; binary: true }>
  | Readonly<{
      ok: false
      code: 'DISABLED' | 'UNTRUSTED_REVISION' | 'TRUST_REJECTED' | 'SHADOWED' | 'NOT_FOUND' | 'UNAUTHORIZED'
    }>
/** Structural Host input. Base consumes it but never owns discovery, desired state, trust, or authorization. */
export type SkillRuntimeInput = Readonly<{
  list(): readonly SkillRuntimeActual[]
  read(resourceId: string, session: { sessionKey: string }): SkillReadResult
  readFile?(
    resourceId: string,
    expectedRevision: string,
    relativePath: string,
    session: { sessionKey: string },
  ): SkillFileReadResult
  /** Host-owned session lease boundary. Every session-scoped discovery/read must enter it. */
  runInWorkspace<T>(sessionKey: string, invoke: () => Promise<T>): Promise<T>
}>
/** Safe discovery view for other bundled extensions; it deliberately has no Skill-body read port. */
export type SkillRuntimeDiscovery = Readonly<Pick<SkillRuntimeInput, 'list' | 'runInWorkspace'>>

const encoder = new TextEncoder()
/** Protocol ceiling for PromptSection.text. The catalog uses that limit and does not add a second one. */
const CATALOG_MAX_BYTES = 65536
/** Per-entry catalog cap in UTF-16 code units, ellipsis included. Descriptors keep the full text. */
const CATALOG_DESCRIPTION_MAX = 250
const READ_MAX_BYTES = 32 * 1024
const CATALOG_PREFIX =
  'Skills are routing data. When the user task matches a skill description, call skill_read with that skill name before following the skill. ' +
  'Read only the matching skills, not every skill. A description is not the skill procedure.\n<available_skills>\n'
const CATALOG_SUFFIX = '</available_skills>'
const meta = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe' as const,
  costHint: undefined,
  deferLoading: undefined,
  requiresApproval: undefined,
}

function active(runtime: SkillRuntimeInput): readonly SkillRuntimeActual[] {
  return runtime.list().filter((skill) => skill.actual === 'ready')
}

type CatalogRow = Readonly<{ name: string; resourceId: string; description: string }>

function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength
}

function foldDescription(description: string): string {
  const flat = description
    .replace(/[\t\r\n]+/gu, ' ')
    .replace(/ +/gu, ' ')
    .trim()
  return flat.length === 0 ? '-' : flat
}

function capDescription(description: string): string {
  if (description.length <= CATALOG_DESCRIPTION_MAX) return description
  // Drop a dangling high surrogate, then trailing space or ellipsis so exactly one mark ends the entry.
  const head = description.slice(0, CATALOG_DESCRIPTION_MAX - 1).replace(/[\uD800-\uDBFF]$/, '')
  return `${head.replace(/[\s…]+$/u, '')}…`
}

function clipUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || utf8Bytes(text) <= maxBytes) return maxBytes <= 0 ? '' : text
  let result = ''
  let bytes = 0
  for (const char of text) {
    const size = utf8Bytes(char)
    if (bytes + size > maxBytes) break
    result += char
    bytes += size
  }
  return result
}

function clipDescription(description: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (utf8Bytes(description) <= maxBytes) return description
  const mark = '…'
  const room = maxBytes - utf8Bytes(mark)
  if (room <= 0) return clipUtf8(mark, maxBytes)
  return `${clipUtf8(description, room)}${mark}`
}

function catalogLine(row: CatalogRow, description: string): string {
  return `${row.name}\t${description}\n`
}

function unsafeRow(row: CatalogRow): boolean {
  return /[\t\r\n]/u.test(row.name) || /[\t\r\n]/u.test(row.resourceId)
}

/** Model-visible skill body. The directory line replaces CLAUDE_SKILL_DIR; Agnes does not set that variable. */
export function presentSkillInstructions(
  resourceId: string,
  result: Readonly<{ content: string; revision?: string; directory?: string }>,
  listedRevision?: string,
): string {
  const revision = result.revision ?? listedRevision ?? '-'
  const directory = result.directory && result.directory.length > 0 ? result.directory : '-'
  return `resourceId: ${resourceId}\nrevision: ${revision}\ndirectory: ${directory}\n\n${result.content}`
}

function renderCatalog(rows: readonly CatalogRow[], descriptionBytes: number | undefined) {
  const lines: string[] = []
  let bytes = utf8Bytes(CATALOG_PREFIX + CATALOG_SUFFIX)
  for (const row of rows) {
    const description =
      descriptionBytes === undefined ? row.description : clipDescription(row.description, descriptionBytes)
    const line = catalogLine(row, description)
    const size = utf8Bytes(line)
    if (bytes + size > CATALOG_MAX_BYTES) break
    lines.push(line)
    bytes += size
  }
  let note = ''
  while (lines.length < rows.length) {
    note = `omitted ${rows.length - lines.length} skills; use tool_search\n`
    if (bytes + utf8Bytes(note) <= CATALOG_MAX_BYTES) break
    const removed = lines.pop()
    if (removed === undefined) throw new Error('Skill catalog header exceeds its budget')
    bytes -= utf8Bytes(removed)
  }
  return { text: CATALOG_PREFIX + lines.join('') + note + CATALOG_SUFFIX, included: lines.length }
}

type CatalogRender = Readonly<{ text: string; included: number; sharedBytes?: number }>

function fits(rows: readonly CatalogRow[], descriptionBytes: number): boolean {
  return renderCatalog(rows, descriptionBytes).included === rows.length
}

function catalogText(rows: readonly CatalogRow[]): CatalogRender {
  if (rows.length === 0) return { text: '', included: 0 }
  const full = renderCatalog(rows, undefined)
  if (full.included === rows.length) return full
  let low = 0
  let high = 0
  for (const row of rows) high = Math.max(high, utf8Bytes(row.description))
  if (!fits(rows, 0)) return { ...renderCatalog(rows, 0), sharedBytes: 0 }
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fits(rows, mid)) low = mid
    else high = mid - 1
  }
  return { ...renderCatalog(rows, low), sharedBytes: low }
}

let catalogCache: { hash: string; text: string } | undefined

function cachedCatalog(skills: readonly SkillRuntimeActual[], log?: Logger): string {
  const rows: CatalogRow[] = []
  const identity: string[] = []
  for (const skill of [...skills].sort((a, b) => a.name.localeCompare(b.name, 'en-US'))) {
    const row = {
      name: skill.name,
      resourceId: skill.resourceId,
      description: capDescription(foldDescription(skill.description ?? '')),
    }
    if (unsafeRow(row)) continue
    rows.push(row)
    identity.push(`${skill.resourceId}\n${row.name}\n${row.description}`)
  }
  const hash = createHash('sha256').update(identity.join('\n')).digest('hex')
  if (catalogCache?.hash === hash) return catalogCache.text
  const { text, included, sharedBytes } = catalogText(rows)
  catalogCache = { hash, text }
  // Counts only: names stay out of the audit stream, and a cache hit never logs again.
  if (sharedBytes !== undefined)
    log?.warn('skill catalog exceeded its budget', {
      ready: skills.length,
      listed: included,
      descriptionBytes: sharedBytes,
    })
  return text
}

function inWorkspace<T>(
  runtime: SkillRuntimeInput,
  sessionKey: string,
  invoke: () => Promise<T>,
): Promise<T> {
  if (typeof runtime.runInWorkspace !== 'function')
    return Promise.reject(
      Object.assign(new Error('E_WORKSPACE_REQUIRED: Skill runtime has no workspace invocation'), {
        code: 'E_WORKSPACE_REQUIRED',
      }),
    )
  return runtime.runInWorkspace(sessionKey, invoke)
}

/**
 * The catalog is its own prompt section. applyContextResults merges sections by id and writes
 * source from the extension identity, so this return does not replace persona or other hooks.
 * additionalContext stays the shared 8192-byte channel and is not used here.
 */
function context(runtime: SkillRuntimeInput, log?: Logger): SkillContextReturn {
  try {
    const text = cachedCatalog(active(runtime), log)
    if (!text) return {}
    return { sections: [{ id: 'skills', order: 160, content: text }] }
  } catch {
    return {}
  }
}

function fileTool(runtime: SkillRuntimeInput): ToolDef {
  return defineTool({
    name: 'skill_read_file',
    description:
      'Read one file from the directory of an enabled, trusted, winner Skill. ' +
      'Pass the exact resourceId, the current revision, and a relative path. The base directory named by skill_read also works with ordinary file tools.',
    parameters: Type.Object(
      {
        resourceId: Type.String({ minLength: 1, maxLength: 256 }),
        expectedRevision: Type.String({ minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' }),
        relativePath: Type.String({ minLength: 1, maxLength: 512 }),
      },
      { additionalProperties: false },
    ),
    meta,
    async execute(args, ctx) {
      return inWorkspace(runtime, ctx.session.key, async () => {
        if (!isSkillRelativePath(args.relativePath))
          return {
            content: [{ type: 'text', text: 'Skill file is unavailable: NOT_FOUND' }],
            isError: true,
            structured: { resourceId: args.resourceId, relativePath: args.relativePath, code: 'NOT_FOUND' },
          }
        const result = runtime.readFile
          ? runtime.readFile(args.resourceId, args.expectedRevision, args.relativePath, {
              sessionKey: ctx.session.key,
            })
          : { ok: false as const, code: 'NOT_FOUND' as const }
        if (!result.ok)
          return {
            content: [{ type: 'text', text: `Skill file is unavailable: ${result.code}` }],
            isError: true,
            structured: {
              resourceId: args.resourceId,
              relativePath: args.relativePath,
              code: result.code,
            },
          }
        if ('binary' in result && result.binary) {
          const ref = await ctx.artifacts.put(result.bytes, { mime: result.mime, name: args.relativePath })
          return {
            content: [{ type: 'ref', ref, mime: result.mime }],
            structured: { resourceId: args.resourceId, relativePath: args.relativePath, artifact: true },
          }
        }
        const text = 'content' in result ? result.content : ''
        const payload = encoder.encode(text)
        if (payload.byteLength <= READ_MAX_BYTES)
          return {
            content: [{ type: 'text', text }],
            structured: { resourceId: args.resourceId, relativePath: args.relativePath },
          }
        const ref = await ctx.artifacts.put(payload, { mime: result.mime, name: args.relativePath })
        return {
          content: [{ type: 'ref', ref, mime: result.mime }],
          structured: { resourceId: args.resourceId, relativePath: args.relativePath, artifact: true },
        }
      })
    },
  })
}

function readTool(runtime: SkillRuntimeInput): ToolDef {
  return defineTool({
    name: 'skill_read',
    description:
      'Read the full instructions for an enabled, trusted Skill using its exact name from available_skills or tool_search. ' +
      'Call this when the user names a Skill or the current task matches that Skill description, before acting on it. ' +
      'Do not use filesystem tools to discover Skills. Use tool_search to find ready Skills by name or description.',
    parameters: Type.Object(
      {
        name: Type.String({
          minLength: 1,
          maxLength: 128,
          description: 'Exact skill name from available_skills or tool_search.',
        }),
      },
      { additionalProperties: false },
    ),
    meta,
    async execute(args, ctx) {
      return inWorkspace(runtime, ctx.session.key, async () => {
        const listed = active(runtime).filter((skill) => skill.name === args.name)
        const skill = listed.length === 1 ? listed[0] : undefined
        if (!skill)
          return {
            content: [{ type: 'text', text: 'Skill is unavailable: NOT_FOUND' }],
            isError: true,
            structured: { name: args.name, code: 'NOT_FOUND' },
          }
        const result = runtime.read(skill.resourceId, { sessionKey: ctx.session.key })
        if (!result.ok)
          return {
            content: [{ type: 'text', text: `Skill is unavailable: ${result.code}` }],
            isError: true,
            structured: { name: args.name, code: result.code },
          }
        const text = presentSkillInstructions(skill.resourceId, result, skill.revision)
        const header = text.slice(0, text.indexOf('\n\n') + 2)
        if (utf8Bytes(text) <= READ_MAX_BYTES)
          return {
            content: [{ type: 'text', text }],
            structured: { name: args.name, resourceId: skill.resourceId },
          }
        const ref = await ctx.artifacts.put(encoder.encode(result.content), {
          mime: 'text/markdown',
          name: 'skill.md',
        })
        return {
          content: [
            { type: 'text', text: header },
            { type: 'ref', ref, mime: 'text/markdown' },
          ],
          structured: { name: args.name, resourceId: skill.resourceId, artifact: true },
        }
      })
    },
  })
}

export function skillsExtension(init: SeamInitContext): ExtensionFactory {
  // A package can be present in a legacy Host before the daemon has supplied a resource-control
  // snapshot. Do not add a callable-looking empty `skill_read` tool in that case: it changes the
  // existing tool disclosure contract while offering no resource capability. The managed worker
  // path always supplies this private runtime, including an intentionally empty skill catalogue.
  if (!init.skillResources) return defineExtension(() => undefined)
  const runtime = init.skillResources
  return defineExtension((agnes) => {
    const disposers: Disposer[] = [
      agnes.registerTool(readTool(runtime)),
      agnes.registerTool(fileTool(runtime)),
      agnes.registerHook('context', (_payload, hookContext) => {
        if (!hookContext?.session?.key)
          throw Object.assign(new Error('E_WORKSPACE_REQUIRED: Skill context has no session'), {
            code: 'E_WORKSPACE_REQUIRED',
          })
        return inWorkspace(runtime, hookContext.session.key, async () => context(runtime, hookContext.log))
      }),
    ]
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  })
}
