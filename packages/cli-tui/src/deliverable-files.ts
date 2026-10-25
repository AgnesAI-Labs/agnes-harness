import { createHash, randomBytes } from 'node:crypto'
import { link, lstat, open, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { ARTIFACT_READ_RPC_MAX_BYTES, type ArtifactReadResult, type ArtifactRef } from '@agnes/protocol'
import type { Client, Session } from '@agnes/sdk'
import type { TuiApp } from './app.js'
import { localPath } from './cd-command.js'
import type { SlashResult } from './commands.js'
import { escapeControl } from './component.js'
import { tt } from './locale-extended.js'
import { oneLine } from './session-commands.js'

const MAX_BYTES = 100 * 1024 * 1024

export type DeliverableFile = {
  /** 1-based position in call order; what the user types to pick one. */
  index: number
  id: string
  name: string
  description: string
  laneId: string
  artifact: ArtifactRef
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

function validRef(ref: unknown): ref is ArtifactRef {
  return (
    isObject(ref) &&
    typeof ref.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(ref.sha256) &&
    typeof ref.size === 'number' &&
    Number.isSafeInteger(ref.size) &&
    ref.size >= 0 &&
    typeof ref.mime === 'string' &&
    ref.mime.length > 0 &&
    ref.mime.length <= 128
  )
}

/** Every file the session's `present` calls delivered, from the daemon's bounded pages, in call order. */
export async function listDeliverables(session: Pick<Session, 'deliverables'>): Promise<DeliverableFile[]> {
  const files: DeliverableFile[] = []
  for (let afterSeq: number | undefined = 0; afterSeq !== undefined; ) {
    const page = await session.deliverables({ afterSeq })
    for (const item of page.items) {
      const data = isObject(item.structured) ? item.structured : {}
      const rows = Array.isArray(data.deliverables) ? data.deliverables : []
      const laneId = typeof data.laneId === 'string' && data.laneId ? data.laneId : 'main'
      rows.forEach((row: unknown, i: number) => {
        if (!isObject(row) || typeof row.name !== 'string' || !row.name || !validRef(row.ref)) return
        files.push({
          index: files.length + 1,
          id: `${laneId}:${item.toolUseId}:${i}`,
          name: row.name,
          description: typeof row.description === 'string' ? row.description : '',
          laneId,
          artifact: { sha256: row.ref.sha256, size: row.ref.size, mime: row.ref.mime },
        })
      })
    }
    afterSeq = page.nextAfterSeq
  }
  return files
}

/** A 1-based index or an id from the listing. */
export function findDeliverable(files: readonly DeliverableFile[], key: string): DeliverableFile | undefined {
  return files.find((f) => f.id === key) ?? (/^\d+$/.test(key) ? files[Number(key) - 1] : undefined)
}

export function deliverableLine(f: DeliverableFile): string {
  return `${f.index}\t${oneLine(f.name)}\t${f.artifact.size}\t${oneLine(f.artifact.mime)}`
}

/** The name is external text: only its last path segment is ever used, and never `.`, `..` or empty. */
export function deliverableBasename(name: string): string {
  const base = basename(name.replace(/\\/g, '/'))
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters in a name are refused on purpose
  if (!base || base === '.' || base === '..' || /[\u0000-\u001f\u007f]/.test(base))
    throw new Error(`deliverable name "${oneLine(name)}" is not a usable file name`)
  return base
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    },
  )
}

const refusal = (path: string) => new Error(`${escapeControl(path)} already exists; use --force to overwrite`)

/**
 * Downloads through the session/lane-authorized bounded artifact.read RPC into a temp file next to the
 * target, checks size and sha256, then moves it into place. A mismatch leaves no file behind.
 * Without `force` an existing target is refused, also against a race (the final step is an exclusive link).
 */
export async function saveDeliverable(
  client: Pick<Client, 'call'>,
  sessionId: string,
  file: DeliverableFile,
  opts: { out?: string; cwd: string; force?: boolean },
): Promise<{ path: string; size: number; sha256: string }> {
  const { artifact, laneId } = file
  if (!validRef(artifact) || artifact.size > MAX_BYTES || !laneId || laneId.length > 512)
    throw new Error('invalid deliverable reference')
  const cwd = resolve(opts.cwd)
  let target: string
  if (opts.out) {
    const abs = resolve(cwd, opts.out)
    const st = await stat(abs).catch(() => undefined)
    target = st?.isDirectory() ? join(abs, deliverableBasename(file.name)) : abs
  } else target = join(cwd, deliverableBasename(file.name))
  if (!opts.force && (await exists(target))) throw refusal(target)

  const temp = join(dirname(target), `.${randomBytes(6).toString('hex')}.agh-download`)
  const handle = await open(temp, 'wx')
  try {
    const hash = createHash('sha256')
    let written = 0
    try {
      for (let start = 0; start < artifact.size || start === 0; start += ARTIFACT_READ_RPC_MAX_BYTES) {
        const end = Math.min(start + ARTIFACT_READ_RPC_MAX_BYTES, artifact.size)
        const range = artifact.size > ARTIFACT_READ_RPC_MAX_BYTES ? `bytes=${start}-${end - 1}` : undefined
        const result = await client.call<ArtifactReadResult>('_agnes/v1/artifact.read', {
          sessionId,
          laneId,
          artifact,
          ...(range ? { range } : {}),
        })
        if (!result.ok)
          throw Object.assign(new Error(`deliverable unavailable: ${result.code}`), { code: result.code })
        if (
          result.artifact.sha256 !== artifact.sha256 ||
          result.artifact.size !== artifact.size ||
          result.artifact.mime !== artifact.mime ||
          result.contentLength !== end - start ||
          (range &&
            (result.status !== 206 || result.contentRange !== `bytes ${start}-${end - 1}/${artifact.size}`))
        )
          throw new Error('deliverable identity mismatch')
        const chunk = Buffer.from(result.base64, 'base64')
        if (chunk.length !== end - start) throw new Error('deliverable length mismatch')
        hash.update(chunk)
        await handle.write(chunk)
        written += chunk.length
        if (!artifact.size) break
      }
      if (written !== artifact.size) throw new Error('deliverable length mismatch')
      if (hash.digest('hex') !== artifact.sha256) throw new Error('deliverable digest mismatch')
    } finally {
      await handle.close()
    }
    if (opts.force) await rename(temp, target)
    else {
      // link fails with EEXIST if the target appeared meanwhile; the temp name is removed below either way.
      await link(temp, target).catch((error: NodeJS.ErrnoException) => {
        throw error.code === 'EEXIST' ? refusal(target) : error
      })
      await rm(temp, { force: true })
    }
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  return { path: target, size: artifact.size, sha256: artifact.sha256 }
}

/** /deliverables lists this session's files; /deliverables save <n|id> [path] downloads one. */
export async function deliverablesSlash(app: TuiApp, line: string): Promise<SlashResult> {
  const locale = app.locale
  const s = app.session
  const words = line.trim().split(/\s+/).slice(1)
  const force = words.includes('--force')
  const [verb, key, out, ...extra] = words.filter((word) => word !== '--force')
  const files = await listDeliverables(s)
  if (verb === undefined)
    return { text: files.length ? files.map(deliverableLine).join('\n') : tt('deliverables.none', locale) }
  if (verb !== 'save' || key === undefined || extra.length > 0)
    return { text: tt('deliverables.usage', locale) }
  const file = findDeliverable(files, key)
  if (!file) return { text: tt('deliverables.unknown', locale, { key: oneLine(key) }) }
  const saved = await saveDeliverable(s.client, s.id, file, {
    cwd: app.cwd,
    force,
    ...(out ? { out: localPath(app, out) } : {}),
  })
  return {
    text: tt('deliverables.saved', locale, {
      path: oneLine(saved.path),
      size: saved.size,
      sha256: saved.sha256,
    }),
  }
}
