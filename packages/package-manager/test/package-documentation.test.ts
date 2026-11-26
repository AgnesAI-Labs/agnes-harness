import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PackageDocsGetParams } from '@agnes/protocol'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createPackageManager,
  emptyLock,
  hashDirectoryAsync,
  type PackageManager,
  packageDir,
  parseSource,
  readLock,
  writeLock,
} from '../src/index.js'

const fsHooks = vi.hoisted((): { beforeReaddir?: (path: string) => void | Promise<void> } => ({}))
vi.mock('node:fs/promises', async (original) => {
  const fs: typeof import('node:fs/promises') = await original()
  return {
    ...fs,
    async readdir(path: string, options: { withFileTypes: true }) {
      await fsHooks.beforeReaddir?.(path)
      return fs.readdir(path, options)
    },
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const profile = 'local-dev'
const id = 'acme/pkg-a'
const agnesVersion = '0.1.0'
const source = parseSource('file:./author')
const en = { found: true, locale: 'en', markdown: '# English' }
const zh = { found: true, locale: 'zh-CN', markdown: '# 中文' }
const missing = { found: false }
const declarations = { en: 'README.md', 'zh-CN': 'docs/Chinese.md' }
let root: string, profileDir: string, author: string, installed: string
let manager: PackageManager

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agh-package-docs-')))
  profileDir = join(root, 'profiles', profile)
  author = join(root, 'author')
  installed = packageDir(root, profile, id)
  mkdirSync(profileDir, { recursive: true })
  writeLock(profileDir, {
    ...emptyLock(profile, agnesVersion),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(
      ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((name) => [
        name,
        { provider: 'local' },
      ]),
    ),
    policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
  })
  cpSync(new URL('./fixtures/pkg-a', import.meta.url), author, { recursive: true })
  manager = createPackageManager({ dataDir: root, cwd: root, agnesVersion, references: async () => [] })
})

afterEach(() => {
  delete fsHooks.beforeReaddir
  rmSync(root, { recursive: true, force: true })
})

function publishFiles(
  agnesDocs: unknown,
  files: Record<string, string | Buffer> = { 'README.md': en.markdown, 'docs/Chinese.md': zh.markdown },
  version = '1.0.0',
) {
  const manifestFile = join(author, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  writeFileSync(manifestFile, JSON.stringify({ ...manifest, version, agnesDocs }))
  for (const [name, markdown] of Object.entries(files)) {
    const path = join(author, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, markdown)
  }
}

async function install() {
  const preview = await manager.inspect(profileDir, source)
  return manager.install(profileDir, source, { expectedIntegrity: preview.integrity })
}

function docs(
  expectedIntegrity: string,
  locale: PackageDocsGetParams['locale'] = 'en',
  signal?: AbortSignal,
) {
  return manager.documentation(profileDir, { id, expectedIntegrity, locale }, signal)
}

it('reads the requested locale from the current installed package without trusting or enabling it', async () => {
  publishFiles(declarations, { 'README.md': `\ufeff${en.markdown}`, 'docs/Chinese.md': zh.markdown })
  const entry = await install()
  expect(entry.state).toMatchObject({ enabled: false, trusted: null })
  rmSync(author, { recursive: true })
  const before = {
    lock: readFileSync(join(profileDir, 'agnes-lock.json')),
    profile: readdirSync(profileDir, { recursive: true }),
    bytes: readdirSync(dirname(installed), { recursive: true }),
  }
  await expect(docs(entry.integrity)).resolves.toEqual(en)
  await expect(docs(entry.integrity, 'zh-CN')).resolves.toEqual(zh)
  await expect(docs(`sha256-${'d'.repeat(64)}`)).resolves.toEqual(missing)
  expect(readFileSync(join(profileDir, 'agnes-lock.json'))).toEqual(before.lock)
  expect(readdirSync(profileDir, { recursive: true })).toEqual(before.profile)
  expect(readdirSync(dirname(installed), { recursive: true })).toEqual(before.bytes)
})

it.each([
  ['no declaration', undefined],
  ['non-record declaration', ['README.md']],
  ['unknown locale', { ...declarations, fr: 'README.md' }],
  ['missing English path', { 'zh-CN': 'docs/Chinese.md' }],
  ['dot directory', { ...declarations, en: './README.md' }],
  ['traversal', { ...declarations, en: '../README.md' }],
  ['node_modules', { ...declarations, en: 'node_modules/README.md' }],
  ['URL', { ...declarations, en: 'https://example.invalid/README.md' }],
  ['escaped character', { ...declarations, en: '%52EADME.md' }],
  ['control character', { ...declarations, en: 'doc\ns/README.md' }],
  ['overlong path', { ...declarations, en: `${'a'.repeat(238)}.md` }],
  ['wrong case', { en: 'readme.md' }],
])('does not find Markdown for %s', async (_label, declaration) => {
  publishFiles(declaration)
  const entry = await install()
  await expect(docs(entry.integrity)).resolves.toEqual(missing)
  await expect(docs(entry.integrity, 'zh-CN')).resolves.toEqual(missing)
})

it.each([
  ['not in the package', undefined],
  ['empty', ''],
  ['blank', '\ufeff \t\n'],
  ['NUL', '前\0后'],
  ['malformed UTF-8', Buffer.from([0xe4, 0xb8])],
  ['over the raw byte limit', '字'.repeat(21_846)],
])('uses English when the Chinese file is %s', async (_label, bytes) => {
  publishFiles(declarations, {
    'README.md': en.markdown,
    ...(bytes === undefined ? {} : { 'docs/Chinese.md': bytes }),
  })
  const entry = await install()
  await expect(docs(entry.integrity, 'zh-CN')).resolves.toEqual(en)
})

it('ignores an invalid Chinese path, but accepts a complete Chinese file at the byte limit even without English', async () => {
  publishFiles({ ...declarations, 'zh-CN': 'docs/Chinese.md?raw=1' })
  const entry = await install()
  await expect(docs(entry.integrity, 'zh-CN')).resolves.toEqual(en)
  rmSync(join(author, 'README.md'))
  const markdown = `${'字'.repeat(21_845)}x`
  publishFiles(declarations, { 'docs/Chinese.md': markdown }, '2.0.0')
  const preview = await manager.inspect(profileDir, source)
  const updated = await manager.update(profileDir, id, source, { expectedIntegrity: preview.integrity })
  await expect(docs(updated.integrity)).resolves.toEqual(missing)
  await expect(docs(updated.integrity, 'zh-CN')).resolves.toEqual({ found: true, locale: 'zh-CN', markdown })
})

it('refuses bytes that differ from the committed tree even when cached file metadata still matches', async () => {
  publishFiles(declarations)
  const entry = await install()
  const readme = join(installed, 'README.md')
  const old = new Date('2020-01-01T00:00:00.000Z')
  for (const file of [
    readme,
    join(installed, 'package.json'),
    join(installed, 'index.ts'),
    join(installed, 'docs/Chinese.md'),
  ])
    utimesSync(file, old, old)
  await expect(hashDirectoryAsync(installed, { exclude: [] })).resolves.toBe(entry.treeIntegrity)
  writeFileSync(readme, '# Altered')
  utimesSync(readme, old, old)
  await expect(docs(entry.integrity)).resolves.toEqual(missing)
})

it('requires the parsed declaration to match the manifest leaf of the verified tree', async () => {
  publishFiles(declarations, { 'README.md': en.markdown, 'other.md': '# Not declared' })
  const entry = await install()
  const path = join(installed, 'package.json')
  const original = readFileSync(path)
  const manifest = JSON.parse(original.toString('utf8'))
  writeFileSync(path, JSON.stringify({ ...manifest, agnesDocs: { en: 'other.md' } }))
  fsHooks.beforeReaddir = (directory) => {
    if (directory !== installed) return
    delete fsHooks.beforeReaddir
    writeFileSync(path, original)
  }
  try {
    await expect(docs(entry.integrity)).resolves.toEqual(missing)
  } finally {
    delete fsHooks.beforeReaddir
  }
  await expect(docs(entry.integrity)).resolves.toEqual(en)
})

it('does not read a package from an in-progress transaction, from a linked tree, or without committed tree evidence', async () => {
  publishFiles(declarations)
  const entry = await install()
  const journal = join(profileDir, '.agnes-package-transaction.json')
  writeFileSync(journal, '{}')
  await expect(docs(entry.integrity)).resolves.toEqual(missing)
  expect(readFileSync(journal, 'utf8')).toBe('{}')
  rmSync(journal)
  const oldRoot = `${installed}-renamed`
  renameSync(installed, oldRoot)
  symlinkSync(oldRoot, installed, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(docs(entry.integrity)).resolves.toEqual(missing)
  rmSync(installed)
  renameSync(oldRoot, installed)
  const lock = readLock(profileDir, { profile, agnesVersion })
  delete lock.packages[id]?.treeIntegrity
  await expect(docs(entry.integrity)).resolves.toEqual(en)
  writeLock(profileDir, lock)
  await expect(docs(entry.integrity)).resolves.toEqual(missing)
})

it('requires an explicit managed directory and complete lock evidence for builtin docs', async () => {
  publishFiles(declarations)
  const entry = await install()
  const lock = readLock(profileDir, { profile, agnesVersion })
  lock.packages[id] = { ...entry, trust: 'builtin' }
  writeLock(profileDir, lock)
  await expect(docs(entry.integrity)).resolves.toEqual(missing)
  const builtinManager = createPackageManager({
    dataDir: root,
    agnesVersion,
    builtinDirectory: (candidate) => (candidate === id ? installed : undefined),
  })
  await expect(
    builtinManager.documentation(profileDir, { id, expectedIntegrity: entry.integrity, locale: 'en' }),
  ).resolves.toEqual(en)
})

it('reads an older version only after rollback makes it current, and returns nothing after uninstall', async () => {
  publishFiles(declarations)
  const original = await install()
  publishFiles(declarations, { 'README.md': '# New docs' }, '2.0.0')
  const preview = await manager.inspect(profileDir, source)
  const updated = await manager.update(profileDir, id, source, { expectedIntegrity: preview.integrity })
  await expect(docs(original.integrity)).resolves.toEqual(missing)
  await expect(docs(updated.integrity)).resolves.toEqual({ ...en, markdown: '# New docs' })
  rmSync(author, { recursive: true })
  await manager.rollback(profileDir, id)
  await expect(docs(original.integrity)).resolves.toEqual(en)
  await expect(docs(updated.integrity)).resolves.toEqual(missing)
  await manager.remove(profileDir, id)
  await expect(docs(original.integrity)).resolves.toEqual(missing)
})

it('refuses a replaced tree even if its bytes still match the lock', async () => {
  publishFiles(declarations)
  const entry = await install()
  fsHooks.beforeReaddir = (directory) => {
    if (directory !== installed) return
    delete fsHooks.beforeReaddir
    const oldRoot = `${installed}-old`
    renameSync(installed, oldRoot)
    cpSync(oldRoot, installed, { recursive: true })
  }
  try {
    await expect(docs(entry.integrity)).resolves.toEqual(missing)
  } finally {
    delete fsHooks.beforeReaddir
  }
  await expect(docs(entry.integrity)).resolves.toEqual(en)
})

it('does not queue excess scans and gives capacity back after a cancellation and a failed scan', async () => {
  publishFiles(declarations)
  const entry = await install()
  const firstStarted = deferred<void>()
  const secondStarted = deferred<void>()
  const cancelGate = deferred<void>()
  const failureGate = deferred<boolean>()
  const abort = new AbortController()
  let arrivals = 0
  fsHooks.beforeReaddir = async (path) => {
    if (path !== installed) return
    if (++arrivals === 1) {
      firstStarted.resolve()
      await cancelGate.promise
    } else if (arrivals === 2) {
      secondStarted.resolve()
      if (await failureGate.promise) throw new Error('fixture tree walk failed')
    }
  }
  const first = docs(entry.integrity, 'en', abort.signal)
  const second = firstStarted.promise.then(() => docs(entry.integrity))
  try {
    await secondStarted.promise
    await expect(docs(entry.integrity)).resolves.toEqual(missing)
    abort.abort()
    cancelGate.resolve()
    await expect(first).resolves.toEqual(missing)
    await expect(docs(entry.integrity)).resolves.toEqual(en)
    failureGate.resolve(true)
    await expect(second).resolves.toEqual(missing)
    await expect(Promise.all([docs(entry.integrity), docs(entry.integrity)])).resolves.toEqual([en, en])
  } finally {
    cancelGate.resolve()
    failureGate.resolve(false)
    await Promise.all([first, second])
    delete fsHooks.beforeReaddir
  }
})
