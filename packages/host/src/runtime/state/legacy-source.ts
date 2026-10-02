import type {
  CommitMutationManifest,
  CommitSideEntry,
  JsonValue,
  RuntimeCommitData,
} from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { type LegacyStateSource, synchronousLegacyCheck } from './legacy-records.js'
import {
  mutationDigest,
  type StoredRecord,
  sameSideCounts,
  sideCounts,
  sideEntryIdentity,
  sideListsDigest,
} from './records.js'
import { integrity, refuse } from './refusal.js'

/** Produced by the owner's verified ledger prefix and immutable version lookup, never by a client. */
export type LegacyCommitSources = {
  readonly physicalSessionId: string
  readonly eventId: string
  readonly commit: RuntimeCommitData
  readonly manifests: readonly CommitMutationManifest[]
  readonly sideEntries: readonly CommitSideEntry[]
  readonly version: StoredRecord
}
export type LegacySourcePorts = {
  /** Cold lookup verifies the original ledger/parent-prefix and continuity before returning this pack. */
  verifiedCommit(source: LegacyStateSource): LegacyCommitSources | null
  /** Authenticate current caller/resource route. Historical ownership alone does not authorize a read. */
  currentRead(source: LegacyStateSource): void
  /** Attest locked producer issuance or an explicit trusted maintenance conversion recipe. */
  sourceProfile(source: LegacyStateSource): void
}

/** Bind original bytes to their actual attestation and manifest after current authorization. */
export function createLegacyStateSourceVerifier(ports: LegacySourcePorts) {
  return (source: LegacyStateSource): void => {
    synchronousLegacyCheck(() => ports.currentRead(source))
    synchronousLegacyCheck(() => ports.sourceProfile(source))
    const evidence = ports.verifiedCommit(source)
    if (evidence === null)
      refuse('incompatible', 'unproven_history', 'legacy State immutable commit source cannot be proved')
    const { commit, manifests, sideEntries, version } = evidence
    if (
      !Array.isArray(manifests) ||
      manifests.some((manifest) => !validateRuntime('CommitMutationManifest', manifest).ok) ||
      !Array.isArray(sideEntries) ||
      sideEntries.some((side) => !validateRuntime('CommitSideEntry', side).ok) ||
      !version ||
      typeof version !== 'object'
    )
      integrity('invalid original legacy State evidence pack')
    if (
      !validateRuntime('RuntimeCommitData', commit).ok ||
      evidence.physicalSessionId !== source.physicalSessionId ||
      evidence.eventId !== source.eventId ||
      commit.commitId !== source.commitId ||
      commit.authorityEpoch !== source.owner.authority.authorityEpoch ||
      manifests.length !== commit.mutationCount ||
      mutationDigest(manifests) !== commit.mutationsDigest ||
      sideListsDigest(sideEntries) !== commit.sideListsDigest ||
      !sameSideCounts(commit.counts, sideCounts(sideEntries))
    )
      integrity('legacy State original commit does not bind its source')
    const identities = new Set<string>()
    for (const side of sideEntries) {
      if (!validateRuntime('CommitSideEntry', side).ok || side.commitId !== source.commitId)
        integrity('legacy State typed side entry does not belong to its commit')
      const key = JSON.stringify([side.kind, sideEntryIdentity(side)])
      if (identities.has(key)) integrity('duplicate legacy State typed side entry')
      identities.add(key)
    }
    if (
      canonicalJsonDigest(sideEntries as unknown as JsonValue) !==
      canonicalJsonDigest(source.sideEntries as unknown as JsonValue)
    )
      integrity('legacy State decoder side facts differ from the original proof')
    if (
      !validateRuntime('Id', version.recordId).ok ||
      !validateRuntime('UInt53', version.recordRevision).ok ||
      version.recordRevision < 1 ||
      !validateRuntime('SchemaRef', version.schema).ok ||
      !validateRuntime('RecordOwner', version.owner).ok ||
      version.minReader !== 1 ||
      !validateRuntime('JsonValue', version.value).ok
    )
      integrity('invalid original legacy State source version')
    const claimed = new Set<string>()
    let sourceManifest: CommitMutationManifest | undefined
    for (const manifest of manifests) {
      if (
        !validateRuntime('CommitMutationManifest', manifest).ok ||
        manifest.commitId !== source.commitId ||
        claimed.has(manifest.recordId)
      )
        integrity('invalid original legacy State manifest pack')
      claimed.add(manifest.recordId)
      if (manifest.recordId === source.recordId) sourceManifest = manifest
    }
    const next = sourceManifest?.next
    if (
      !sourceManifest ||
      !next ||
      version.recordRevision !== next.recordRevision ||
      (sourceManifest.previousRevision === null
        ? version.recordRevision !== 1
        : version.recordRevision !== sourceManifest.previousRevision + 1) ||
      canonicalJsonDigest(version.schema as unknown as JsonValue) !==
        canonicalJsonDigest(next.schema as unknown as JsonValue) ||
      canonicalJsonDigest({
        owner: version.owner as unknown as JsonValue,
        value: version.value as JsonValue,
      }) !== next.digest
    )
      integrity('legacy State manifest does not bind its immutable source version')
    const original = version
    if (
      original.recordId !== source.recordId ||
      original.recordRevision !== source.recordRevision ||
      canonicalJsonDigest(original.schema as unknown as JsonValue) !==
        canonicalJsonDigest(source.schema as unknown as JsonValue) ||
      canonicalJsonDigest(original.owner as unknown as JsonValue) !==
        canonicalJsonDigest(source.owner as unknown as JsonValue) ||
      canonicalJsonDigest(original.value as JsonValue) !== canonicalJsonDigest(source.value) ||
      canonicalJsonDigest({
        owner: original.owner as unknown as JsonValue,
        value: original.value as JsonValue,
      }) !== source.digest
    )
      integrity('legacy State source differs from its original immutable version')
  }
}
