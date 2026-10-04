import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type { AuthorityFence, AuthorityRoute, DataRef } from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { createReferenceAuthorityDirectory } from '../../../../examples/runtime-reference/src/providers/authority-directory.js'
import type {
  PublicationSourceEvidence,
  PublicationSourcePlan,
} from '../../src/runtime/maintenance/authority-publication-owner.js'
import { createAuthorityDirectoryProvider } from '../../src/runtime/providers/authority-directory.js'

interface FixturePlan {
  upgradeId: string
  validationRef: DataRef
  sources: { previous: AuthorityRoute; expectedRevision: number; fence: AuthorityFence }[]
}
interface Approval {
  readonly upgradeId: string
  readonly validationRef: DataRef
  readonly authorityIds: readonly string[]
  readonly sourceFences?: readonly AuthorityFence[]
}
const file = (directory: string) => join(directory, 'fixture-source-owners.json')
const digest = (value: unknown) => canonicalJsonDigest(JSON.parse(JSON.stringify(value)))

/** Synthetic owner and original-validation ledger for abstract C52 tests only; not production wiring. */
function fixtureResolver(directory: string) {
  return async (upgradeId: string): Promise<Outcome<PublicationSourcePlan>> => {
    const ledger = JSON.parse(readFileSync(file(directory), 'utf8')) as Record<string, FixturePlan>
    const locked = ledger[upgradeId]
    if (!locked) throw new Error('fixture owner absent')
    const plan: PublicationSourcePlan = {
      ...locked,
      sources: locked.sources.map((source) => ({
        ...source,
        owner: {
          authority: source.fence.source,
          binding: source.previous.providerBinding,
          locationRef: source.previous.locationRef,
          transfer: { probe: async () => ({ ok: true, value: { state: 'fenced', fence: source.fence } }) },
        },
      })),
      verify: async (evidence: PublicationSourceEvidence) => ({
        ok: true,
        value:
          digest({
            ...evidence,
            sources: [...evidence.sources].sort((a, b) =>
              a.previous.logicalAuthorityId.localeCompare(b.previous.logicalAuthorityId),
            ),
          }) ===
          digest({
            ...locked,
            sources: [...locked.sources].sort((a, b) =>
              a.previous.logicalAuthorityId.localeCompare(b.previous.logicalAuthorityId),
            ),
          }),
      }),
    }
    return { ok: true, value: plan }
  }
}

function instrument<
  T extends {
    read: ReturnType<typeof createAuthorityDirectoryProvider>['read']
    approveUpgrade(input: Approval, call: CallContext): Promise<Outcome<{ readonly upgradeId: string }>>
  },
>(provider: T, directory: string): T {
  const approve = provider.approveUpgrade.bind(provider)
  return Object.assign(provider, {
    async approveUpgrade(input: Approval, call: CallContext) {
      const sources: FixturePlan['sources'] = []
      for (const id of input.authorityIds) {
        const prior = await provider.read({ kind: 'authority', logicalAuthorityId: id }, call)
        const fence = input.sourceFences?.find((item) => item.source.authorityId === id)
        if (prior.ok && prior.value.kind === 'authority' && fence)
          sources.push({ previous: prior.value.route, expectedRevision: prior.value.revision, fence })
      }
      const outcome = await approve(input, call)
      if (outcome.ok) {
        const ledger = existsSync(file(directory)) ? JSON.parse(readFileSync(file(directory), 'utf8')) : {}
        ledger[input.upgradeId] = { upgradeId: input.upgradeId, validationRef: input.validationRef, sources }
        mkdirSync(directory, { recursive: true })
        writeFileSync(file(directory), JSON.stringify(ledger))
      }
      return outcome
    },
  })
}

export function createFixtureAuthorityDirectory(
  options: Parameters<typeof createAuthorityDirectoryProvider>[0],
) {
  const provider = createAuthorityDirectoryProvider({
    ...options,
    publicationPlan: options.publicationPlan ?? fixtureResolver(options.directory),
  })
  return options.publicationPlan ? provider : instrument(provider, options.directory)
}
export function createFixtureReferenceDirectory(
  options: Parameters<typeof createReferenceAuthorityDirectory>[0],
) {
  const provider = createReferenceAuthorityDirectory({
    ...options,
    publicationPlan: options.publicationPlan ?? fixtureResolver(options.directory),
  })
  return options.publicationPlan ? provider : instrument(provider, options.directory)
}
