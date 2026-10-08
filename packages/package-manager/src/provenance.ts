import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  jcs,
  type McpServerDefinitionInput,
  type PackageProvenance,
  type PackageSourcePolicy,
} from '@agnes/protocol'
import { deploymentFetch } from '@agnes/system-node/deployment-network'
import { verify } from 'sigstore'
import { PackageError } from './errors.js'
import { canonical, readStaticJson } from './integrity.js'
import type { FetchedSource, PackageSource } from './sources.js'

export type OfficialCatalogStatement = Readonly<{
  keyId: string
  issuedAt: string
  mcpDefinitions?: readonly string[]
  entries: readonly Readonly<{
    id: string
    version: string
    source: PackageSource
    treeIntegrity: string
    publisher: string
  }>[]
}>
export type PackageSourceConfiguration = Readonly<{
  allowedSources?: PackageSourcePolicy['allowedSources']
  /** Maintainer-owned public keys, never keys supplied by downloaded packages/catalogs. */
  officialKeys?: Readonly<Record<string, string>>
  officialCatalog?: Readonly<{ statement: OfficialCatalogStatement; signature: string }>
}>
const failure = (reason: string) =>
  new PackageError('E_LOCK_MISMATCH', reason, { code: 'E_PACKAGE_PROVENANCE' })

export function readPackageSourceConfiguration(profileDir: string): PackageSourceConfiguration {
  const file = join(profileDir, 'package-sources.json')
  if (!existsSync(file)) return {}
  const value = readStaticJson(file)
  if (
    Object.keys(value).some((key) => !['allowedSources', 'officialKeys', 'officialCatalog'].includes(key)) ||
    (value.allowedSources !== undefined &&
      !['official-only', 'official+npm-with-provenance', 'any-with-confirmation'].includes(
        typeof value.allowedSources === 'string' ? value.allowedSources : '',
      ))
  )
    throw failure('Invalid package source policy; fix package-sources.json')
  return value as PackageSourceConfiguration
}

export function packageSourcePolicy(profileDir: string): PackageSourcePolicy {
  return {
    allowedSources: readPackageSourceConfiguration(profileDir).allowedSources ?? 'any-with-confirmation',
  }
}

export function recordProvenance(
  source: PackageSource,
  fetched: FetchedSource,
  treeIntegrity: string,
): PackageProvenance {
  return {
    source: (fetched.source ?? source) as PackageProvenance['source'],
    sourceKind:
      source.type === 'npm'
        ? 'npm'
        : source.type === 'git'
          ? 'git'
          : source.type === 'url'
            ? 'tarball'
            : 'local-folder',
    resolvedLocation: fetched.resolvedLocation ?? (fetched.source ?? source).ref,
    version: fetched.version,
    integrity: fetched.integrity,
    treeIntegrity,
    signatureVerified: false,
    verification: 'unverified',
    ...(fetched.sourceKind ? { sourceKind: fetched.sourceKind } : {}),
    ...(fetched.releasedAt ? { releasedAt: fetched.releasedAt } : {}),
    ...(fetched.provenance ?? {}),
  }
}

function verifiedCatalogStatement(config: PackageSourceConfiguration): OfficialCatalogStatement | undefined {
  if (!config.officialCatalog) return undefined
  try {
    const { statement, signature } = config.officialCatalog
    const pem = config.officialKeys?.[statement.keyId]
    if (
      !pem ||
      typeof signature !== 'string' ||
      !Array.isArray(statement.entries) ||
      statement.entries.length > 4096 ||
      !Number.isFinite(Date.parse(statement.issuedAt)) ||
      (statement.mcpDefinitions !== undefined &&
        (!Array.isArray(statement.mcpDefinitions) ||
          statement.mcpDefinitions.length > 4096 ||
          statement.mcpDefinitions.some(
            (value) => typeof value !== 'string' || !/^sha256-[a-f0-9]{64}$/.test(value),
          )))
    )
      throw failure('Official catalog has no trusted signing key')
    const key = createPublicKey(pem)
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      !verifySignature(null, Buffer.from(canonical(statement)), key, Buffer.from(signature, 'base64'))
    )
      throw failure('Official catalog signature is invalid')
    return statement
  } catch (error) {
    if (error instanceof PackageError) throw error
    throw failure('Official catalog signature is invalid')
  }
}

/** MCP defaults can be relaxed only for an exact definition signed by the administrator's key. */
export function isOfficialMcpDefinition(
  config: PackageSourceConfiguration,
  definition: McpServerDefinitionInput,
): boolean {
  const statement = verifiedCatalogStatement(config)
  const hash = `sha256-${createHash('sha256').update(jcs(definition)).digest('hex')}`
  return statement?.mcpDefinitions?.includes(hash) === true
}

/** A valid catalog signature authorizes only an exact resolved source/version/tree tuple. */
export function verifyOfficialCatalog(
  config: PackageSourceConfiguration,
  id: string,
  provenance: PackageProvenance,
): PackageProvenance {
  if (provenance.verification === 'official-ed25519')
    provenance = {
      ...provenance,
      verification: 'unverified',
      signatureVerified: false,
      sourceKind:
        provenance.source.type === 'npm'
          ? 'npm'
          : provenance.source.type === 'git'
            ? 'git'
            : provenance.source.type === 'url'
              ? 'tarball'
              : 'local-folder',
    }
  if (!config.officialCatalog) return provenance
  try {
    const statement = verifiedCatalogStatement(config)
    if (!statement) return provenance
    const row = statement.entries.find(
      (entry) =>
        entry.id === id &&
        entry.version === provenance.version &&
        canonical(entry.source) === canonical(provenance.source),
    )
    if (!row) return provenance
    if (
      row.treeIntegrity !== provenance.treeIntegrity ||
      typeof row.publisher !== 'string' ||
      !row.publisher ||
      row.publisher.length > 2048
    )
      throw failure('Official catalog package integrity differs')
    return {
      ...provenance,
      sourceKind: 'official-catalog',
      signatureVerified: true,
      verification: 'official-ed25519',
      publisher: row.publisher,
    }
  } catch (error) {
    if (error instanceof PackageError) throw error
    throw failure('Official catalog signature is invalid')
  }
}

export function enforcePackageSourcePolicy(profileDir: string, provenance: PackageProvenance): void {
  const { allowedSources } = packageSourcePolicy(profileDir)
  if (
    allowedSources === 'any-with-confirmation' ||
    provenance.verification === 'official-ed25519' ||
    (allowedSources === 'official+npm-with-provenance' &&
      provenance.source.type === 'npm' &&
      provenance.verification === 'npm-sigstore')
  )
    return
  throw new PackageError('E_DEP_MISSING', 'Package source is not permitted by the administrator policy', {
    code: 'E_PACKAGE_SOURCE_POLICY',
  })
}

/** Verify publisher evidence against both the pinned npm identity and actual packed archive bytes. */
export async function verifyNpmProvenance(
  input: { name: string; version: string; integrity: string; bundle: unknown },
  verifyBundle: (bundle: unknown) => Promise<unknown> = (bundle) =>
    verify(bundle as Parameters<typeof verify>[0]),
): Promise<Pick<PackageProvenance, 'publisher' | 'signatureVerified' | 'verification'>> {
  try {
    const signer = (await verifyBundle(input.bundle)) as { identity?: { subjectAlternativeName?: string } }
    const bundle = input.bundle as { dsseEnvelope?: { payload?: string; payloadType?: string } }
    if (
      bundle.dsseEnvelope?.payloadType !== 'application/vnd.in-toto+json' ||
      typeof bundle.dsseEnvelope.payload !== 'string'
    )
      throw failure('Invalid npm provenance envelope')
    const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8')) as {
      subject?: { name?: string; digest?: { sha512?: string } }[]
      predicate?: {
        buildDefinition?: { externalParameters?: { workflow?: { repository?: string } } }
        invocation?: { configSource?: { uri?: string } }
      }
    }
    const digest = Buffer.from(input.integrity.slice('sha512-'.length), 'base64').toString('hex')
    const purl = `pkg:npm/${input.name.startsWith('@') ? `%40${input.name.slice(1)}` : input.name}@${input.version}`
    if (!statement.subject?.some((subject) => subject.name === purl && subject.digest?.sha512 === digest))
      throw failure('npm provenance subject differs from downloaded package')
    const publisher = signer.identity?.subjectAlternativeName
    if (typeof publisher !== 'string' || !publisher || publisher.length > 2048)
      throw failure('npm provenance omits publisher identity')
    return { publisher, signatureVerified: true, verification: 'npm-sigstore' }
  } catch (error) {
    if (error instanceof PackageError) throw error
    throw failure('npm provenance signature or transparency proof is invalid')
  }
}

/** Registry evidence endpoints are never a package-controlled arbitrary URL. */
export async function fetchNpmProvenance(
  name: string,
  version: string,
  integrity: string,
  signal?: AbortSignal,
  cachePath?: string,
): Promise<Pick<PackageProvenance, 'publisher' | 'signatureVerified' | 'verification'> | undefined> {
  const request = async (url: string): Promise<Record<string, unknown>> => {
    const parsed = new URL(url)
    if (parsed.origin !== 'https://registry.npmjs.org' || parsed.username || parsed.password)
      throw failure('npm provenance endpoint is not the official registry')
    const timeout = AbortSignal.timeout(15_000)
    const response = await deploymentFetch(parsed, {
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!response.ok) throw failure('npm provenance registry request failed')
    const chunks: Uint8Array[] = []
    let size = 0
    if (!response.body) throw failure('npm provenance registry response is empty')
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 1024 * 1024) throw failure('npm provenance response exceeds limit')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  }
  const metadata = await request(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
  )
  const dist = metadata.dist as { integrity?: unknown; attestations?: { url?: unknown } } | undefined
  if (dist?.integrity !== integrity) throw failure('npm registry integrity differs from downloaded package')
  if (!dist.attestations) {
    const user = metadata._npmUser as { name?: unknown } | undefined
    return typeof user?.name === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(user.name)
      ? { publisher: `npm:${user.name}`, signatureVerified: false, verification: 'unverified' }
      : undefined
  }
  if (typeof dist.attestations.url !== 'string') throw failure('npm provenance endpoint is invalid')
  const evidence = await request(dist.attestations.url)
  const attestations = evidence.attestations as { predicateType?: string; bundle?: unknown }[] | undefined
  const provenance = attestations?.find(
    (row) =>
      row.predicateType === 'https://slsa.dev/provenance/v0.2' ||
      row.predicateType === 'https://slsa.dev/provenance/v1',
  )
  if (!provenance?.bundle) throw failure('npm provenance statement is missing')
  return verifyNpmProvenance({ name, version, integrity, bundle: provenance.bundle }, (bundle) =>
    verify(bundle as Parameters<typeof verify>[0], {
      ...(cachePath ? { tufCachePath: cachePath } : {}),
      timeout: 5000,
      retry: 0,
    }),
  )
}
