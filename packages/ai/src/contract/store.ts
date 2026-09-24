import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { type ToolSchema, validateAgainst, validateContractManifest } from '@agnes/protocol'
import { ToolSchema as ToolShape } from '@agnes/protocol/gen/model'
import type { ContractStore } from '../contract-store.js'
import { AiSetupError } from '../errors.js'
import { sha256Hex } from '../hash.js'
import type { ContractManifest, ContractSyntax } from './types.js'

export type ContractStoreOptions = { dir: string; contractIds: string[] }
type Loaded = { manifest: ContractManifest; prefix: Uint8Array; tools: ToolSchema[]; syntax: ContractSyntax }
const ID = /^agnes-model-contract@v?\d+$/
const safeId = (id: string): boolean => ID.test(id) && id.length <= 32
const fail = (id: string, segment: string): never => {
  throw new AiSetupError('CONTRACT_MISMATCH', { contractId: safeId(id) ? id : '<invalid>', segment })
}
const inside = (root: string, target: string): boolean => {
  const path = relative(root, target)
  return path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path)
}
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const keys = (x: Record<string, unknown>, allowed: string[]) =>
  Object.keys(x).every((k) => allowed.includes(k))

function syntaxShape(x: unknown): x is ContractSyntax {
  if (!object(x) || !keys(x, ['toolCallFormats', 'thinkTag', 'chatTemplate'])) return false
  if (
    !Array.isArray(x.toolCallFormats) ||
    !x.toolCallFormats.length ||
    !x.toolCallFormats.every((v) => typeof v === 'string' && v.length > 0)
  )
    return false
  if (x.chatTemplate !== undefined && typeof x.chatTemplate !== 'string') return false
  if (
    x.thinkTag !== undefined &&
    (!object(x.thinkTag) ||
      !keys(x.thinkTag, ['open', 'close']) ||
      typeof x.thinkTag.open !== 'string' ||
      !x.thinkTag.open ||
      typeof x.thinkTag.close !== 'string' ||
      !x.thinkTag.close)
  )
    return false
  return true
}

function parse(bytes: Uint8Array, id: string, segment: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return fail(id, segment)
  }
}

function loadOne(root: string, id: string): Loaded {
  let base: string
  try {
    base = realpathSync(join(root, id))
  } catch {
    return fail(id, 'missing')
  }
  if (!inside(root, base)) return fail(id, 'path')
  const read = (file: string): Uint8Array => {
    let fd: number | undefined
    try {
      const path = realpathSync(join(base, file))
      if (!inside(base, path)) return fail(id, 'path')
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      if (!fstatSync(fd).isFile()) return fail(id, 'path')
      return new Uint8Array(readFileSync(fd))
    } catch (e) {
      if (e instanceof AiSetupError) throw e
      return fail(id, 'missing')
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
  const decoded = parse(read('manifest.json'), id, 'manifest')
  const checked = validateContractManifest(decoded)
  if (!checked.ok) return fail(id, 'manifest')
  const manifest = checked.value
  if (manifest.version !== id) return fail(id, 'version')
  const segment = (name: 'prefix' | 'tools' | 'syntax', file: string): Uint8Array => {
    const bytes = read(file)
    // Deliberately raw bytes: JSON whitespace and prefix line endings are contract material.
    if (sha256Hex(bytes) !== manifest.sha256[name]) return fail(id, name)
    return bytes
  }
  const prefix = segment('prefix', 'prefix.bin')
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(prefix)
  } catch {
    return fail(id, 'prefix')
  }
  const tools = parse(segment('tools', 'tools.json'), id, 'tools')
  if (!Array.isArray(tools) || !tools.every((tool) => validateAgainst(ToolShape, tool).ok))
    return fail(id, 'tools')
  if (new Set(tools.map((tool) => (tool as ToolSchema).name)).size !== tools.length) return fail(id, 'tools')
  const syntax = parse(segment('syntax', 'syntax.json'), id, 'syntax')
  if (!syntaxShape(syntax)) return fail(id, 'syntax')
  // The fifth artifact must exist, but public documentation is never treated as executable code.
  read('public.md')
  return { manifest, prefix, tools: tools as ToolSchema[], syntax }
}

/** A verified snapshot. Returned byte/data copies cannot modify future reads or contract hashes. */
export class FileContractStore implements ContractStore {
  readonly #loaded = new Map<string, Loaded>()
  constructor(opts: ContractStoreOptions) {
    // Validate every identifier before the first filesystem access, including empty-store calls.
    for (const id of opts.contractIds) if (!safeId(id)) fail(id, 'id')
    if (new Set(opts.contractIds).size !== opts.contractIds.length)
      fail(opts.contractIds[0] ?? '', 'duplicate')
    if (opts.contractIds.length) {
      let root: string
      try {
        root = realpathSync(opts.dir)
      } catch {
        throw new AiSetupError('CONTRACT_MISMATCH', { contractId: opts.contractIds[0], segment: 'missing' })
      }
      for (const id of opts.contractIds) this.#loaded.set(id, loadOne(root, id))
    }
    Object.freeze(this)
  }
  prefixHash(id: string | null): string | null {
    return id === null ? null : (this.#loaded.get(id)?.manifest.sha256.prefix ?? null)
  }
  prefixBytes(id: string): Uint8Array {
    return this.must(id).prefix.slice()
  }
  tools(id: string): ToolSchema[] {
    return structuredClone(this.must(id).tools)
  }
  syntax(id: string): ContractSyntax {
    return structuredClone(this.must(id).syntax)
  }
  manifest(id: string): ContractManifest {
    return structuredClone(this.must(id).manifest)
  }
  private must(id: string): Loaded {
    const loaded = this.#loaded.get(id)
    if (!loaded) return fail(id, 'not-loaded')
    return loaded
  }
}

export function loadContractStore(opts: ContractStoreOptions): FileContractStore {
  return new FileContractStore(opts)
}
