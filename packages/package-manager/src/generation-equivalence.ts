import type { GenerationSeams, PluginGenerationSnapshot } from './runtime-snapshots-generations.js'

/** The recorded inputs a generation is reused for; any difference means snapshotting afresh. */
export type GenerationReuseInputs = Readonly<{
  artifactDigest: string
  compatibility: string
  packages: PluginGenerationSnapshot['packages']
  resourcesDigest?: string
  seams?: GenerationSeams
}>
export const matchesGenerationBuildInputs = (
  snapshot: PluginGenerationSnapshot,
  expected: GenerationReuseInputs,
): boolean =>
  snapshot.artifact.digest === expected.artifactDigest &&
  snapshot.compatibility === expected.compatibility &&
  snapshot.resourcesDigest === expected.resourcesDigest &&
  JSON.stringify(snapshot.packages) === JSON.stringify(expected.packages) &&
  JSON.stringify(snapshot.seams ?? null) === JSON.stringify(expected.seams ?? null)

/** Different durable ids may attest identical code. Never infer this from versions or mtimes. */
export function sameGenerationCodeAndSources(
  a: PluginGenerationSnapshot,
  b: PluginGenerationSnapshot,
): boolean {
  const sources = (snapshot: PluginGenerationSnapshot) =>
    snapshot.sources.map((source) => ({
      ...source,
      snapshot: { ...source.snapshot, directory: '' },
    }))
  return (
    !!a.seams &&
    !!b.seams &&
    a.resourcesDigest !== undefined &&
    a.compatibility === b.compatibility &&
    a.artifact.digest === b.artifact.digest &&
    a.resourcesDigest === b.resourcesDigest &&
    JSON.stringify(a.seams) === JSON.stringify(b.seams) &&
    JSON.stringify(a.packages) === JSON.stringify(b.packages) &&
    JSON.stringify(sources(a)) === JSON.stringify(sources(b))
  )
}
