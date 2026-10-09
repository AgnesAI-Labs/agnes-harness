import type { ArtifactGcReachabilitySnapshotIdentity } from './gc-execution-prerequisite.js'
import {
  ARTIFACT_ROOT_SOURCES,
  type ArtifactRoot,
  type ArtifactRootSnapshot,
  type ArtifactRootSource,
} from './reachability.js'

const SHA256 = /^[0-9a-f]{64}$/u

export type ArtifactGcRootOwnerSnapshot = ArtifactRootSnapshot & Readonly<{ epoch: string }>
export type ArtifactGcRootOwner = Readonly<{
  source: ArtifactRootSource
  snapshot(): Promise<ArtifactGcRootOwnerSnapshot>
}>
export type ArtifactGcFiveSourceSnapshot = Readonly<{
  identity: ArtifactGcReachabilitySnapshotIdentity
  roots: Readonly<Record<ArtifactRootSource, ArtifactRootSnapshot>>
}>

function canonicalRoots(source: ArtifactRootSource, roots: readonly ArtifactRoot[]): readonly ArtifactRoot[] {
  const seen = new Set<string>()
  const result = roots.map((root) => {
    if (!SHA256.test(root.sha256) || seen.has(root.sha256))
      throw new Error(`artifact GC ${source} owner returned an invalid or duplicate digest`)
    seen.add(root.sha256)
    const artifactUri = root.artifactUri
    if (
      (source === 'request-media' && artifactUri !== `artifact://${root.sha256}`) ||
      (artifactUri !== undefined && artifactUri !== `artifact://${root.sha256}`)
    )
      throw new Error(`artifact GC ${source} owner returned an invalid artifact URI`)
    return Object.freeze({ sha256: root.sha256, ...(artifactUri ? { artifactUri } : {}) })
  })
  return Object.freeze(result.sort((left, right) => left.sha256.localeCompare(right.sha256)))
}

/** Collects exactly one complete, deterministic snapshot from each durable root owner. */
export async function collectArtifactGcFiveSourceSnapshot(
  owners: readonly ArtifactGcRootOwner[],
  sha256Utf8: (value: string) => string,
): Promise<ArtifactGcFiveSourceSnapshot> {
  const bySource = new Map(owners.map((owner) => [owner.source, owner]))
  if (owners.length !== ARTIFACT_ROOT_SOURCES.length || bySource.size !== ARTIFACT_ROOT_SOURCES.length)
    throw new Error('artifact GC requires exactly one owner for each of the five root sources')
  const material: Array<
    Readonly<{ source: ArtifactRootSource; epoch: string; roots: readonly ArtifactRoot[] }>
  > = []
  const roots = Object.create(null) as Record<ArtifactRootSource, ArtifactRootSnapshot>
  for (const source of ARTIFACT_ROOT_SOURCES) {
    const owner = bySource.get(source)
    if (!owner) throw new Error(`artifact GC root owner is missing: ${source}`)
    const snapshot = await owner.snapshot()
    if (
      snapshot.complete !== true ||
      typeof snapshot.epoch !== 'string' ||
      snapshot.epoch.length < 1 ||
      snapshot.epoch.length > 256 ||
      snapshot.epoch !== snapshot.epoch.normalize('NFC')
    )
      throw new Error(`artifact GC ${source} root snapshot is incomplete or invalid`)
    const canonical = canonicalRoots(source, snapshot.roots)
    roots[source] = Object.freeze({ complete: true, roots: canonical })
    material.push(Object.freeze({ source, epoch: snapshot.epoch, roots: canonical }))
  }
  const canonical = JSON.stringify(material)
  const hash = sha256Utf8(canonical)
  const epochHash = sha256Utf8(JSON.stringify(material.map(({ source, epoch }) => [source, epoch])))
  if (!SHA256.test(hash) || !SHA256.test(epochHash))
    throw new Error('artifact GC snapshot hash runtime returned an invalid digest')
  return Object.freeze({
    identity: Object.freeze({ epoch: `roots-v1-${epochHash}`, hash }),
    roots: Object.freeze(roots),
  })
}
