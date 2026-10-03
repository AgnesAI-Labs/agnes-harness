import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateOwnedAuthorSchemaSource, validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import {
  digestJson,
  identifyPackage,
  MANIFEST_FILE,
  readPackageTree,
  sha256Hex,
  type TreeFile,
  ZERO_DIGEST,
} from '../../src/runtime/source-snapshot.js'

const packageDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../examples/packages/runtime-ui-bundle/v1',
)

type Row = Record<string, unknown> & { packageDigest: string }
type Manifest = {
  id: string
  version: string
  packageDigest: string
  entries: { web: string }
  schemas: { ref: { typeId: string; revision: number; digest: string }; path: string }[]
  renderers: (Row & {
    entry: string
    viewSchemaRanges: { typeId: string; minRevision: number; maxRevision: number }[]
  })[]
  clientServices: Row[]
  files: { path: string; digest: string; bytes: number }[]
  build: { sourceDigest: string }
  clientAssets: { styles: { path: string }[] }
}

function readTree(): TreeFile[] {
  const tree = readPackageTree(packageDir)
  if (!tree.ok) throw new Error(tree.message)
  return tree.value
}

const manifestOf = (files: readonly TreeFile[]): Manifest =>
  JSON.parse(files.find((file) => file.path === MANIFEST_FILE)?.bytes.toString('utf8') ?? 'null')

const memberOf = (files: readonly TreeFile[], ref: string): TreeFile | undefined =>
  files.find((file) => `./${file.path}` === ref)

/** The contract digest: the reader zeroes the top-level field, this zeroes the nested ones first. */
function contractDigest(files: readonly TreeFile[]): string {
  const zero = (rows: readonly Row[]) => rows.map((row) => ({ ...row, packageDigest: ZERO_DIGEST }))
  const manifest = manifestOf(files)
  const zeroed = {
    ...manifest,
    renderers: zero(manifest.renderers),
    clientServices: zero(manifest.clientServices),
  }
  const identified = identifyPackage(withMember(files, MANIFEST_FILE, Buffer.from(JSON.stringify(zeroed))))
  if (!identified.ok) throw new Error(identified.message)
  return identified.value.treeDigest
}

function withMember(files: readonly TreeFile[], path: string, bytes: Buffer): TreeFile[] {
  return files.map((file) => (file.path === path ? { ...file, bytes } : file))
}

describe('runtime UI bundle example package', () => {
  it('is a valid runtime plugin manifest with client assets', () => {
    const manifest = manifestOf(readTree())
    expect(validateRuntime('RuntimePluginManifest', manifest)).toMatchObject({ ok: true })
    expect(manifest.clientAssets.styles).toEqual([{ kind: 'stylesheet', path: './web/index.css' }])
  })

  it('lists every package file except the manifest with its real bytes', () => {
    const files = readTree()
    const manifest = manifestOf(files)
    expect(manifest.files.map((row) => row.path)).toEqual(
      files.filter((file) => file.path !== MANIFEST_FILE).map((file) => `./${file.path}`),
    )
    for (const row of manifest.files) {
      const bytes = memberOf(files, row.path)?.bytes ?? Buffer.alloc(0)
      expect({ path: row.path, digest: sha256Hex(bytes), bytes: bytes.length }).toEqual(row)
    }
    expect(files.every((file) => file.mode === 'file')).toBe(true)
    expect(manifest.build.sourceDigest).toBe(digestJson(manifest.files))
  })

  it('claims the contract tree digest at the top level and in every renderer', () => {
    const files = readTree()
    const manifest = manifestOf(files)
    const digest = contractDigest(files)
    expect(manifest.packageDigest).toBe(digest)
    expect(manifest.renderers.map((renderer) => renderer.packageDigest)).toEqual([digest])
  })

  it('documents that the default reader zeroes only the top-level packageDigest', () => {
    // identifyPackage keeps renderers[].packageDigest in the digested manifest, so a package whose
    // renderer carries its digest cannot match. Update this case when the reader follows the contract.
    const files = readTree()
    const manifest = manifestOf(files)
    const identified = identifyPackage(files)
    if (!identified.ok) throw new Error(identified.message)
    expect(identified.value.claimedPackageDigest).toBe(manifest.packageDigest)
    expect(identified.value.treeDigest).not.toBe(manifest.packageDigest)
  })

  it('names its own view schema, renderer entry and stylesheet', () => {
    const files = readTree()
    const manifest = manifestOf(files)
    const [schema] = manifest.schemas
    if (schema === undefined) throw new Error('the manifest declares no schema')
    const document = JSON.parse(memberOf(files, schema.path)?.bytes.toString('utf8') ?? 'null')
    const checked = validateOwnedAuthorSchemaSource({
      ownerPackageId: manifest.id,
      name: document.$ref.slice('#/$defs/'.length),
      typeId: schema.ref.typeId,
      revision: schema.ref.revision,
      document,
    })
    expect(checked.ref).toEqual(schema.ref)
    expect(manifest.renderers.map((renderer) => renderer.viewSchemaRanges)).toEqual([
      [{ typeId: schema.ref.typeId, minRevision: schema.ref.revision, maxRevision: schema.ref.revision }],
    ])
    for (const path of [
      manifest.entries.web,
      ...manifest.renderers.map((renderer) => renderer.entry),
      ...manifest.clientAssets.styles.map((style) => style.path),
    ])
      expect(memberOf(files, path), path).toBeDefined()
  })

  it('changes the digest when web/index.js changes, even under the same id and version', () => {
    const files = readTree()
    const manifest = manifestOf(files)
    const original = memberOf(files, './web/index.js')?.bytes ?? Buffer.alloc(0)
    const flipped = Buffer.from(original)
    flipped[0] = (flipped[0] ?? 0) ^ 1
    const tampered = withMember(files, 'web/index.js', flipped)
    expect(contractDigest(tampered)).not.toBe(manifest.packageDigest)
    expect(manifest.files.find((row) => row.path === './web/index.js')?.digest).not.toBe(sha256Hex(flipped))

    // A correctly rebuilt manifest for changed bytes that keeps 1.0.0: same identity, another digest.
    const changed = Buffer.concat([original, Buffer.from('// changed\n')])
    const rows = manifest.files.map((row) =>
      row.path === './web/index.js' ? { ...row, digest: sha256Hex(changed), bytes: changed.length } : row,
    )
    const rebuilt = { ...manifest, files: rows, build: { ...manifest.build, sourceDigest: digestJson(rows) } }
    const republished = withMember(
      withMember(files, 'web/index.js', changed),
      MANIFEST_FILE,
      Buffer.from(JSON.stringify(rebuilt)),
    )
    expect(manifestOf(republished)).toMatchObject({ id: manifest.id, version: '1.0.0' })
    expect(contractDigest(republished)).not.toBe(manifest.packageDigest)
  })
})
