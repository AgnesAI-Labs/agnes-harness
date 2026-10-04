import type { SessionIdleGatePort, SessionOwnerIdentity } from '@agnes/host'
import {
  type ComparisonRetirementBackend,
  ComparisonRetirementError,
  type ComparisonRetirementIdleGate,
} from './comparison-retirement-service.js'

type Lease = { check(): Promise<void>; release(): Promise<void> }
interface RemoteIdleOwner {
  acquireIdleGate(members: readonly SessionOwnerIdentity[], signal?: AbortSignal): Promise<Lease>
}
const refuse = (): never => {
  throw new ComparisonRetirementError('COMPARISON_IDLE_OWNER_CHANGED')
}

/** Read-only owner lookup: never opens, wakes or recovers a missing runtime. */
export function comparisonIdleGate(options: {
  ledger: Pick<ComparisonRetirementBackend['ledger'], 'readSessionOwnerEvidence' | 'inspectSessionTree'>
  local?: SessionIdleGatePort
  remote?: (sessionKey: string) => RemoteIdleOwner | undefined
}): ComparisonRetirementIdleGate {
  return {
    async acquire(input) {
      input.signal.throwIfAborted()
      const trees = structuredClone(input.trees)
      const members = trees.flatMap((tree) => tree.members)
      const evidence = trees.flatMap((tree) => tree.ownerEvidence.map((row) => row.evidence ?? refuse()))
      if (
        members.length !== evidence.length ||
        new Set(members.map((row) => row.sessionKey)).size !== members.length
      )
        refuse()
      const leases: Lease[] = []
      const channels = new Map<string, RemoteIdleOwner>()
      const checkEvidence = async () => {
        input.signal.throwIfAborted()
        for (const before of evidence) {
          const after = options.ledger.readSessionOwnerEvidence(before.owner.sessionKey)
          if (
            !after ||
            after.owner.writerRunId !== before.owner.writerRunId ||
            after.owner.ownerEpoch !== before.owner.ownerEpoch ||
            after.closed?.finalSeq !== before.closed?.finalSeq ||
            !!after.closed !== !!before.closed
          )
            refuse()
        }
        for (const tree of trees) {
          const current = await options.ledger.inspectSessionTree(tree.rootSessionKey)
          if (JSON.stringify(current.members) !== JSON.stringify(tree.members)) refuse()
        }
        for (const [key, channel] of channels) if (options.remote?.(key) !== channel) refuse()
      }
      const release = async () => {
        const results = await Promise.allSettled(
          leases
            .splice(0)
            .reverse()
            .map((lease) => lease.release()),
        )
        const failure = results.find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
      }
      try {
        await checkEvidence()
        if (options.local) {
          const port = options.local
          const { token } = await port.acquire({ members: evidence.map((value) => value.owner) })
          leases.push({ check: () => port.check(token), release: () => port.release(token) })
        } else {
          const parents = new Map(members.map((member) => [member.sessionKey, member.parentKey]))
          // A raw reopened child has its own channel. Other live children belong to the nearest
          // registered ancestor's Host; closed members need only durable exact-owner evidence.
          for (const row of evidence) {
            const channel = options.remote?.(row.owner.sessionKey)
            if (channel && !row.closed) channels.set(row.owner.sessionKey, channel)
          }
          const groups = new Map<string, SessionOwnerIdentity[]>()
          for (const row of evidence) {
            if (row.closed) continue
            let key: string | null = row.owner.sessionKey
            const seen = new Set<string>()
            while (key && !channels.has(key)) {
              if (seen.has(key)) refuse()
              seen.add(key)
              key = parents.get(key) ?? null
            }
            const groupKey = key ?? refuse()
            const group = groups.get(groupKey) ?? []
            group.push(row.owner)
            groups.set(groupKey, group)
          }
          for (const [key, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
            input.signal.throwIfAborted()
            leases.push(await (channels.get(key) ?? refuse()).acquireIdleGate(group, input.signal))
          }
        }
        await checkEvidence()
        return {
          async check() {
            await checkEvidence()
            for (const lease of leases) await lease.check()
            await checkEvidence()
          },
          release,
        }
      } catch (error) {
        await release()
        throw error
      }
    },
  }
}
