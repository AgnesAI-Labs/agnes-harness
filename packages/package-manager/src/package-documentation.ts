import { lstat, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PACKAGE_DOCS_MAX_BYTES, type PackageDocsGetParams, type PackageDocsGetResult } from '@agnes/protocol'
import { captureDirectoryLeaves, readBoundedPackageManifest } from './directory-digest.js'
import { own } from './integrity.js'
import { readBoundary } from './inventory-boundary.js'
import type { Lockfile } from './lockfile.js'
import { checkCancelled } from './ports.js'
import { packageDir } from './sources.js'
import { hasPackageTransaction } from './store.js'

const MAX_MANIFEST_BYTES = 1024 * 1024
const NOT_FOUND = Object.freeze({ found: false } satisfies PackageDocsGetResult)
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const LOCK_BOUNDARY = ['agnes-lock.json']
const STORED_SOURCES: readonly string[] = ['file', 'git', 'npm', 'local']
let activeReads = 0

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function documentationPath(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 240 ||
    !value.endsWith('.md') ||
    /[^A-Za-z0-9._/-]/.test(value) ||
    value.split('/').some((part) => !/^[A-Za-z0-9]/.test(part) || part === 'node_modules')
  )
    return undefined
  return value
}

function markdown(bytes: Buffer | undefined): string | undefined {
  if (!bytes) return undefined
  try {
    const text = UTF8.decode(bytes)
    return !text.includes('\0') && text.trim() ? text : undefined
  } catch {
    return undefined
  }
}

export type PackageDocumentationReader = (
  profileDir: string,
  request: Omit<PackageDocsGetParams, 'profile'>,
  signal?: AbortSignal,
) => Promise<PackageDocsGetResult>

export function createPackageDocumentationReader(
  options: { dataDir: string; builtinDirectory?: (id: string) => string | undefined },
  load: (profileDir: string) => Lockfile,
): PackageDocumentationReader {
  return (profileDir, request, signal) =>
    readInstalledPackageDocumentation({
      profileDir,
      request,
      dataDir: options.dataDir,
      builtinDirectory: options.builtinDirectory,
      load,
      signal,
    })
}

/** Reads one committed installed tree. No inventory, recovery, source resolution, or cache. */
async function readInstalledPackageDocumentation(input: {
  profileDir: string
  dataDir: string
  load: (profileDir: string) => Lockfile
  request: Omit<PackageDocsGetParams, 'profile'>
  builtinDirectory: ((id: string) => string | undefined) | undefined
  signal: AbortSignal | undefined
}): Promise<PackageDocsGetResult> {
  const { profileDir, request, signal } = input
  if (signal?.aborted || activeReads >= 2) return NOT_FOUND
  activeReads++
  try {
    const boundary = readBoundary(profileDir, LOCK_BOUNDARY)
    if (boundary === 'absent' || hasPackageTransaction(input)) return NOT_FOUND
    const { id, expectedIntegrity, locale } = request
    const lock = input.load(profileDir)
    const entry = own(lock.packages, id)
    if (
      !entry?.treeIntegrity ||
      entry.integrity !== expectedIntegrity ||
      entry.source.type === 'workspace' ||
      (entry.trust !== 'builtin' && !STORED_SOURCES.includes(entry.source.type))
    )
      return NOT_FOUND

    const configuredBuiltin = entry.trust === 'builtin' ? input.builtinDirectory?.(id) : undefined
    if (entry.trust === 'builtin' && !configuredBuiltin) return NOT_FOUND
    let root: string
    let managedRoot: string | undefined
    if (configuredBuiltin) root = resolve(configuredBuiltin)
    else {
      managedRoot = await realpath(input.dataDir)
      root = packageDir(managedRoot, lock.profile, id)
    }
    checkCancelled(signal)
    const observedRoot = await lstat(root)
    if (!observedRoot.isDirectory() || (await realpath(root)) !== root) return NOT_FOUND

    const manifest = await readBoundedPackageManifest(root, MAX_MANIFEST_BYTES, signal)
    const parsed: unknown = JSON.parse(UTF8.decode(manifest))
    if (!record(parsed) || parsed.name !== id || parsed.version !== entry.version) return NOT_FOUND
    const docs = parsed.agnesDocs
    if (!record(docs) || Object.keys(docs).some((key) => key !== 'en' && key !== 'zh-CN')) return NOT_FOUND
    const english = documentationPath(docs.en)
    if (!english) return NOT_FOUND
    const chinese = locale === 'zh-CN' ? documentationPath(docs['zh-CN']) : undefined
    const paths = new Set(chinese ? [chinese, english] : [english])
    const capture = await captureDirectoryLeaves(root, {
      observedRoot,
      manifest,
      paths,
      maxBytes: PACKAGE_DOCS_MAX_BYTES,
      ...(signal ? { signal } : {}),
    })
    if (managedRoot !== undefined && (await realpath(input.dataDir)) !== managedRoot) return NOT_FOUND
    if (
      signal?.aborted ||
      capture.digest !== entry.treeIntegrity ||
      hasPackageTransaction(input) ||
      readBoundary(profileDir, LOCK_BOUNDARY) !== boundary
    )
      return NOT_FOUND

    if (chinese) {
      const text = markdown(capture.bytes.get(chinese))
      if (text !== undefined) return { found: true, locale: 'zh-CN', markdown: text }
    }
    const text = markdown(capture.bytes.get(english))
    return text === undefined ? NOT_FOUND : { found: true, locale: 'en', markdown: text }
  } catch {
    return NOT_FOUND
  } finally {
    activeReads--
  }
}
