import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { createPlatform } from '@agnes/host'
import {
  createPrivateDirectorySync,
  windowsEnsurePrivateDirectorySync,
  windowsProtectPrivateDirectorySync,
} from '@agnes/system-node'

type RootRecord = {
  version: 1
  id: string
  dataDir: string
  requestedRoot: string
  canonicalRoot: string
  ownerNonce: string
  directoryIdentity: string
  state: 'prepared' | 'ready'
}
type Checkpoint = 'after-mkdir' | 'after-marker' | 'after-prepared' | 'before-ready'
export class ManagedChatRootError extends Error {
  readonly code: string
  constructor(
    cause?: unknown,
    readonly registeredRoot?: Readonly<{ id: string; root: string }>,
  ) {
    super('Managed chats directory cannot be prepared or verified', { cause })
    const code = (cause as NodeJS.ErrnoException | undefined)?.code
    this.code =
      cause instanceof ManagedChatRootError
        ? cause.code
        : code === 'EEXIST'
          ? 'MANAGED_CHAT_ROOT_CONFLICT'
          : code === 'EACCES' || code === 'EPERM'
            ? 'MANAGED_CHAT_ROOT_PERMISSION_DENIED'
            : 'MANAGED_CHAT_ROOT_UNAVAILABLE'
  }
}
/** Identity comes only from the private durable record, never from the external marker. */
function trustedRecord(value: unknown, dataDir: string): RootRecord {
  const record = value as Partial<RootRecord> | null
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
  if (
    record?.version !== 1 ||
    record.dataDir !== dataDir ||
    !['prepared', 'ready'].includes(record.state ?? '') ||
    typeof record.id !== 'string' ||
    !uuid.test(record.id) ||
    typeof record.ownerNonce !== 'string' ||
    !uuid.test(record.ownerNonce) ||
    typeof record.canonicalRoot !== 'string' ||
    !isAbsolute(record.canonicalRoot) ||
    record.canonicalRoot.includes('\0') ||
    record.requestedRoot !== record.canonicalRoot ||
    typeof record.directoryIdentity !== 'string' ||
    !/^\d+:\d+$/.test(record.directoryIdentity)
  )
    throw new ManagedChatRootError()
  return record as RootRecord
}

const contains = (parent: string, child: string) => {
  const suffix = relative(parent, child)
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix))
}
async function identity(path: string): Promise<string> {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new ManagedChatRootError()
  if (
    createPlatform().os !== 'win32' &&
    (Number(info.mode) & 0o077 || info.uid !== BigInt(process.getuid?.() ?? Number(info.uid)))
  )
    throw new ManagedChatRootError()
  if (createPlatform().os === 'win32') windowsProtectPrivateDirectorySync(path)
  return `${info.dev}:${info.ino}`
}
async function persist(path: string, record: RootRecord) {
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(record))
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, path)
  if (createPlatform().os !== 'win32') {
    const parent = await open(join(path, '..'), 'r')
    try {
      await parent.sync()
    } finally {
      await parent.close()
    }
  }
}
async function verify(record: RootRecord, dataDir: string, privateRoots: readonly string[]) {
  if (
    record.version !== 1 ||
    !['prepared', 'ready'].includes(record.state) ||
    record.dataDir !== dataDir ||
    !record.id ||
    !record.ownerNonce ||
    record.requestedRoot !== record.canonicalRoot
  )
    throw new ManagedChatRootError()
  for (const root of privateRoots)
    if (contains(root, record.canonicalRoot) || contains(record.canonicalRoot, root))
      throw new ManagedChatRootError()
  if ((await identity(record.canonicalRoot)) !== record.directoryIdentity) throw new ManagedChatRootError()
  const markerPath = join(record.canonicalRoot, '.agh-managed-root.json')
  const markerInfo = await lstat(markerPath)
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) throw new ManagedChatRootError()
  const marker = JSON.parse(await readFile(markerPath, 'utf8'))
  if (marker.version !== 1 || marker.id !== record.id || marker.ownerNonce !== record.ownerNonce)
    throw new ManagedChatRootError()
  if ((await identity(record.canonicalRoot)) !== record.directoryIdentity) throw new ManagedChatRootError()
}

/** Must run under the daemon's existing single-writer lock. Orphan candidates are never adopted. */
export async function prepareManagedChatRoot(input: {
  dataDir: string
  privateRoots: readonly string[]
  documentsDirectory: () => Promise<string>
  checkpoint?: (stage: Checkpoint) => void
}): Promise<{ id: string; root: string }> {
  let registeredRoot: Readonly<{ id: string; root: string }> | undefined
  try {
    await mkdir(input.dataDir, { recursive: true, mode: 0o700 })
    const dataDir = await realpath(input.dataDir)
    const privateRoots = await Promise.all(
      [dataDir, ...input.privateRoots].map(async (root) => {
        try {
          return await realpath(root)
        } catch {
          return root
        }
      }),
    )
    const metadata = join(dataDir, 'managed-chat-root.json')
    let record: RootRecord | undefined
    try {
      const info = await lstat(metadata)
      if (!info.isFile() || info.isSymbolicLink()) throw new ManagedChatRootError()
      record = trustedRecord(JSON.parse(await readFile(metadata, 'utf8')), dataDir)
      registeredRoot = { id: record.id, root: record.canonicalRoot }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!record) {
      const documents = await realpath(await input.documentsDirectory())
      for (const root of privateRoots) if (contains(root, documents)) throw new ManagedChatRootError()
      const parent = join(documents, 'Agnes Harness')
      for (const root of privateRoots) if (contains(root, parent)) throw new ManagedChatRootError()
      if (createPlatform().os === 'win32') windowsEnsurePrivateDirectorySync(parent)
      else await mkdir(parent, { recursive: true, mode: 0o700 })
      await identity(parent)
      const id = randomUUID()
      const root = join(parent, `chats-${id}`)
      if (createPlatform().os === 'win32') createPrivateDirectorySync(root)
      else await mkdir(root, { mode: 0o700 })
      const directoryIdentity = await identity(root)
      input.checkpoint?.('after-mkdir')
      const ownerNonce = randomUUID()
      const marker = await open(
        join(root, '.agh-managed-root.json'),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      )
      try {
        await marker.writeFile(JSON.stringify({ version: 1, id, ownerNonce }))
        await marker.sync()
      } finally {
        await marker.close()
      }
      if (createPlatform().os !== 'win32') {
        const directory = await open(root, 'r')
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
      record = {
        version: 1,
        id,
        dataDir,
        requestedRoot: root,
        canonicalRoot: root,
        ownerNonce,
        directoryIdentity,
        state: 'prepared',
      }
      await verify(record, dataDir, privateRoots)
      input.checkpoint?.('after-marker')
      await persist(metadata, record)
      registeredRoot = { id: record.id, root: record.canonicalRoot }
      input.checkpoint?.('after-prepared')
    }
    await verify(record, dataDir, privateRoots)
    if (record.state === 'prepared') {
      input.checkpoint?.('before-ready')
      record = { ...record, state: 'ready' }
      await persist(metadata, record)
    }
    return { id: record.id, root: record.canonicalRoot }
  } catch (cause) {
    if (cause instanceof ManagedChatRootError && !registeredRoot) throw cause
    throw new ManagedChatRootError(cause, registeredRoot)
  }
}
