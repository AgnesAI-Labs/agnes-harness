import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { jcs } from '@agnes/protocol'
import {
  canonicalJsonDigest,
  validateOwnedAuthorSchemaSource,
  validateRuntime,
} from '@agnes/protocol/runtime'

/** Real static package bytes; no module entry is imported or installed. */
export function assemblyUiFixture() {
  const base = new URL('../../../../../examples/packages/runtime-ui-bundle/v1/', import.meta.url)
  const manifest = validateRuntime(
    'RuntimePluginManifest',
    JSON.parse(readFileSync(new URL('agnes.plugin.json', base), 'utf8')),
  )
  if (!manifest.ok) throw new Error('Invalid static UI manifest')
  const pkg = manifest.value
  const records = pkg.files.map((file) => {
    const bytes = readFileSync(new URL(file.path, base))
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== file.digest || bytes.length !== file.bytes) throw new Error('Static UI bytes changed')
    return { path: file.path.slice(2), mode: 'file', bytes: bytes.length, digest }
  })
  const zero = '0'.repeat(64)
  const normalized = {
    ...pkg,
    packageDigest: zero,
    renderers: pkg.renderers.map((row) => ({ ...row, packageDigest: zero })),
    clientServices: pkg.clientServices.map((row) => ({ ...row, packageDigest: zero })),
  }
  const bytes = Buffer.from(jcs(normalized))
  records.push({
    path: 'agnes.plugin.json',
    mode: 'file',
    bytes: bytes.length,
    digest: createHash('sha256').update(bytes).digest('hex'),
  })
  const tree = canonicalJsonDigest(
    records.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))),
  )
  if (tree !== pkg.packageDigest) throw new Error('Static UI tree changed')
  const sourceRef = pkg.schemas[0]
  const renderer = pkg.renderers[0]
  if (!sourceRef || !renderer || !pkg.entries.web) throw new Error('Missing static UI contribution')
  const document = JSON.parse(readFileSync(new URL(sourceRef.path, base), 'utf8'))
  const source = {
    ownerPackageId: pkg.id,
    name: document.$ref.slice('#/$defs/'.length),
    typeId: sourceRef.ref.typeId,
    revision: sourceRef.ref.revision,
    document,
  }
  const schema = validateOwnedAuthorSchemaSource(source).ref
  if (jcs(schema) !== jcs(sourceRef.ref)) throw new Error('Static UI schema changed')
  const entry = pkg.files.find((file) => file.path === pkg.entries.web)
  if (!entry) throw new Error('Missing static UI entry')
  return {
    manifest: pkg,
    source,
    bundle: {
      bundleId: renderer.id,
      digest: entry.digest,
      target: 'web',
      schemas: [schema],
      packageId: pkg.id,
      version: pkg.version,
      entry: 'web',
      viewSchemaRanges: renderer.viewSchemaRanges,
    },
  }
}

/** Changed variants are generated from real entry bytes and never written into the fixture. */
export function changedAssemblyUiEntryDigest(tampered = false): string {
  const original = readFileSync(
    new URL('../../../../../examples/packages/runtime-ui-bundle/v1/web/index.js', import.meta.url),
  )
  const changed = tampered
    ? Buffer.from(original)
    : Buffer.concat([original, Buffer.from('\n// rebuilt entry\n')])
  if (tampered) changed[0] = (changed[0] ?? 0) ^ 1
  return createHash('sha256').update(changed).digest('hex')
}
