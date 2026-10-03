import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { jcs } from '../../../../packages/protocol/src/index.js'
import type { RuntimeWireTypes as Wire } from '../../../../packages/protocol/src/runtime/index.js'

export type BrokenPluginMode =
  | 'normal'
  | 'malicious-manifest'
  | 'outside-path'
  | 'symlink'
  | 'case-conflict'
  | 'omitted-files'
  | 'entry-missing'
  | 'npm-integrity'
  | 'git-commit'
  | 'required-ui'
  | 'download-cancelled'
  | 'unapproved-build'
  | 'secret-build'

export interface BrokenPluginFixture {
  readonly mode: BrokenPluginMode
  readonly lock: Wire['PackageLockEntry']
  readonly locator: Wire['PackageLocator']
  readonly archive: Buffer
  readonly files: readonly { readonly path: string; readonly bytes: Buffer }[]
  readonly build?: {
    readonly script: string
    readonly network: readonly string[]
    readonly readPaths: readonly string[]
    readonly writePaths: readonly string[]
    readonly secretEnv?: readonly string[]
  }
  readonly requiredUi: readonly { readonly target: 'web' }[]
  readonly cancelDownload: boolean
}

const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const digest = (value: unknown): string => hash(jcs(value))
const zero = '0'.repeat(64)

/** Deterministic synthetic bytes; no plugin entry, install script or build script is evaluated. */
export function createBrokenPlugin(
  mode: BrokenPluginMode = 'normal',
  kind: 'local' | 'npm' | 'git' = 'local',
): BrokenPluginFixture {
  const entry = 'runtime/index.js'
  const source = Buffer.from('throw new Error("fixture entry must never execute");\n')
  const packageJson = Buffer.from(
    jcs({
      name: 'example.inspect',
      version: '1.0.0',
      dependencies: {},
      peerDependencies: {},
      devDependencies: { 'fixture-dev-only': '^1.0.0' },
      scripts: { install: 'exit 91', build: 'exit 92' },
    }),
  )
  const members = [
    { path: 'package.json', bytes: packageJson },
    { path: entry, bytes: source },
  ]
  const manifest = {
    $schema: 'https://agnes.ai/schema/runtime/v1/plugin-manifest.schema.json',
    kind: 'agh.plugin',
    schemaVersion: '1.0',
    id: 'example.inspect',
    version: '1.0.0',
    runtimeApiMajor: 1,
    packageDigest: zero,
    entries: { runtime: `./${entry}` },
    schemas: [],
    providers: [],
    domains: [],
    tools: [],
    renderers: [],
    clientServices: [],
    permissions: { runtime: [], web: [], tui: [], im: [], sdk: [] },
    dependencies: [],
    files: members.map((file) => ({
      path: `./${file.path}`,
      bytes: file.bytes.length,
      digest: hash(file.bytes),
    })),
    build: {
      generatorVersion: '1.0.0',
      sourceDigest: digest(members.map((file) => file.path)),
      authorDefinitionDigest: zero,
      reproducible: false,
    },
  }
  if (mode === 'malicious-manifest') Object.assign(manifest, { runtimeApiMajor: 99 })
  if (mode === 'outside-path')
    manifest.files[1] = { path: './../outside.js', digest: hash(source), bytes: source.length }
  if (mode === 'omitted-files') manifest.files.pop()
  if (mode === 'entry-missing') manifest.entries.runtime = './runtime/missing.js'
  if (mode === 'case-conflict') members.push({ path: 'Runtime/index.js', bytes: source })
  const sorted = [...members, { path: 'manifest.json', bytes: Buffer.from(jcs(manifest)) }].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  )
  const packageDigest = digest(
    sorted.map((file) => ({
      path: file.path,
      mode: 'file',
      bytes: file.bytes.length,
      digest: hash(file.bytes),
    })),
  )
  manifest.packageDigest = packageDigest
  const files = sorted.map((file) =>
    file.path === 'manifest.json' ? { ...file, bytes: Buffer.from(jcs(manifest)) } : file,
  )
  const packed = tar(
    kind === 'npm' ? files.map((file) => ({ ...file, path: `package/${file.path}` })) : files,
    mode === 'symlink' ? (kind === 'npm' ? `package/${entry}` : entry) : null,
  )
  const archive = kind === 'npm' ? gzipSync(packed) : packed
  const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`
  const locator: Wire['PackageLocator'] =
    kind === 'npm'
      ? {
          kind,
          sourceId: 'fixture.npm',
          name: manifest.id,
          version: manifest.version,
          integrity,
          digest: packageDigest,
        }
      : kind === 'git'
        ? {
            kind,
            sourceId: 'fixture.git',
            repository: 'https://example.invalid/plugin.git',
            commit: 'a'.repeat(40),
            subdirectory: '',
            digest: packageDigest,
          }
        : { kind, sourceId: 'fixture.local', pathRef: 'fixture.package', digest: packageDigest }
  const manifestText = jcs(manifest)
  const lock: Wire['PackageLockEntry'] = {
    packageId: manifest.id,
    version: manifest.version,
    digest: packageDigest,
    locator,
    manifestRef: {
      kind: 'inline',
      schema: { typeId: 'agh.package/manifest@1', revision: 1, digest: hash('agh.package/manifest@1') },
      value: manifest,
      bytes: Buffer.byteLength(manifestText),
      digest: hash(manifestText),
    },
    dependencies: [],
  }
  const fetched =
    mode === 'git-commit' && locator.kind === 'git' ? { ...locator, commit: 'b'.repeat(40) } : locator
  const bytes = mode === 'npm-integrity' ? Buffer.concat([archive, Buffer.alloc(512)]) : archive
  return {
    mode,
    lock,
    locator: fetched,
    archive: bytes,
    files,
    requiredUi: mode === 'required-ui' ? [{ target: 'web' }] : [],
    cancelDownload: mode === 'download-cancelled',
    ...(['unapproved-build', 'secret-build'].includes(mode)
      ? {
          build: {
            script: 'node build.js',
            network: [],
            readPaths: ['./'],
            writePaths: ['./dist'],
            ...(mode === 'secret-build' ? { secretEnv: ['FIXTURE_SECRET'] } : {}),
          },
        }
      : {}),
  }
}

/** Materialize regular files only. Link rejection uses the archive so it is portable on Windows. */
export function writeBrokenPlugin(root: string, fixture: BrokenPluginFixture): void {
  for (const file of fixture.files) {
    const target = join(root, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.bytes)
  }
}

function tar(
  files: readonly { readonly path: string; readonly bytes: Buffer }[],
  link: string | null,
): Buffer {
  const chunks: Buffer[] = []
  for (const file of files) {
    const header = Buffer.alloc(512),
      bytes = file.path === link ? Buffer.alloc(0) : file.bytes
    header.write(file.path, 0, 100, 'utf8')
    for (const [offset, width, value] of [
      [100, 8, 0o644],
      [108, 8, 0],
      [116, 8, 0],
      [124, 12, bytes.length],
      [136, 12, 0],
    ])
      header.write(`${(value ?? 0).toString(8).padStart((width ?? 0) - 1, '0')}\0`, offset)
    header.fill(32, 148, 156)
    header[156] = file.path === link ? 0x32 : 0x30
    if (file.path === link) header.write('../outside.js', 157)
    header.write('ustar\0', 257)
    header.write('00', 263)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
    chunks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}
