import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { SkillInstallResult } from '@agnes/extension-api'
import type { ResourceControlMethodName, ResourceOperation, SkillDescriptor } from '@agnes/protocol'
import {
  createPrivateDirectorySync,
  createPrivateFileSync,
  hasPrivateDaclSync,
  renameWriteThrough,
} from '@agnes/system-node'
import {
  inlineInstallBundle,
  parseInstallInput,
  refuseSkillCollision,
  refuseSkillTarget,
} from './skill-install-content.js'
import {
  assertInstallPath,
  boundedInstallFile,
  type InstallBundle,
  installDigest,
  installError,
  readInstallBundle,
  type SkillDiscovery,
  unlinked,
  within,
} from './skill-install-files.js'
import type { SkillInstallInvocation } from './skill-install-port.js'
import { publishInstallBundle } from './skill-install-publish.js'

export type SkillInstallAuthority = Readonly<{
  principalId: string
  profile: string
  workspaceRoot: string
  agnesHome: string
  /** Revalidates authenticated ownership. No plugin-provided actor participates. */
  assertActive(): void
  /** Backend lease verification; called again after receipt writes and before effect admission. */
  verifyPermission?(): Promise<void>
  /** Retains cancellation routing until the background task settles. */
  background?(task: Promise<void>): void
  ask(summary: string, bindingHash: string, signal: AbortSignal): Promise<boolean>
  resources(method: ResourceControlMethodName, params: Record<string, unknown>): Promise<unknown>
}>
type Proposal = {
  owner: string
  invocation: SkillInstallInvocation
  authority: SkillInstallAuthority
  bundle: InstallBundle
  target: string
  rootKey: 'workspace-agnes' | 'user-agnes'
  expires: number
  result: SkillInstallResult
  pendingWrite?: Promise<void>
  busy: boolean
  approvalAbort?: AbortController
  signal?: AbortSignal
  cancelled: boolean
  review?: Readonly<{ principalId: string; digest: string; at: string }>
}

/** All filesystem effects are behind a server-authenticated authority and a content-bound approval. */
export function createSkillInstaller(directory: string, discovery: SkillDiscovery) {
  const proposals = new Map<string, Proposal>()
  const locks = new Set<string>()
  const ownerOf = (i: SkillInstallInvocation, a: SkillInstallAuthority) =>
    installDigest(
      JSON.stringify([a.principalId, a.profile, i.sessionKey, i.packageId, i.snapshotId, i.rowId]),
    )
  const save = async (p: Proposal, result = p.result) => {
    unlinked(directory)
    mkdirSync(dirname(directory), { recursive: true, mode: 0o700 })
    try {
      createPrivateDirectorySync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (!hasPrivateDaclSync(directory)) throw installError('SKILL_RECEIPT_DIRECTORY_UNSAFE')
    const file = join(directory, `${p.result.proposalId}.json`)
    unlinked(file)
    const temp = `${file}.${randomUUID()}.tmp`
    const fd = createPrivateFileSync(temp)
    try {
      try {
        writeFileSync(
          fd,
          JSON.stringify({
            owner: p.owner,
            result,
            ...(p.review ? { review: p.review } : {}),
            origin: {
              sessionKey: p.invocation.sessionKey,
              packageId: p.invocation.packageId,
              snapshotId: p.invocation.snapshotId,
              rowId: p.invocation.rowId,
              toolUseId: p.invocation.toolUseId,
            },
          }),
        )
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      await renameWriteThrough(temp, file)
    } finally {
      if (existsSync(temp)) rmSync(temp)
    }
  }
  const check = (p: Proposal) => {
    if (p.cancelled) throw installError('SKILL_INSTALL_CANCELLED')
    p.signal?.throwIfAborted()
    p.authority.assertActive()
    if (Date.now() > p.expires) throw installError('SKILL_INSTALL_EXPIRED')
  }
  const verify = async (p: Proposal) => {
    check(p)
    await p.authority.verifyPermission?.()
    check(p)
  }
  const update = async (p: Proposal, patch: Partial<SkillInstallResult>) => {
    const committed = (p.pendingWrite ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (['ready', 'installed', 'failed', 'cancelled', 'interrupted'].includes(p.result.state)) return
        const result = Object.freeze({ ...p.result, ...patch })
        await save(p, result)
        // Public terminal states acknowledge completed persistence, not an in-flight rename/flush.
        p.result = result
      })
    p.pendingWrite = committed
    await committed
  }
  const call = async (p: Proposal, method: ResourceControlMethodName, params: Record<string, unknown>) => {
    await verify(p)
    check(p)
    return p.authority.resources(method, { profile: p.authority.profile, ...params })
  }
  const effect = async (
    p: Proposal,
    phase: string,
    method: ResourceControlMethodName,
    params: Record<string, unknown>,
  ) => {
    await update(p, { phase })
    const receipt = (await call(p, method, {
      ...params,
      commandId: `${p.result.proposalId}-${phase}`,
    })) as { operationId: string }
    if (!receipt?.operationId) throw installError('SKILL_INSTALL_BAD_RECEIPT')
    await update(p, { resourceOperationId: receipt.operationId })
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const op = (await call(p, '_agnes/v1/resources.operation.get', {
        operationId: receipt.operationId,
      })) as ResourceOperation
      if (op.state === 'succeeded') return
      if (op.state === 'failed' || op.state === 'cancelled')
        throw installError('SKILL_RESOURCE_OPERATION_FAILED')
      await delay(150)
    }
    throw installError('SKILL_RESOURCE_OPERATION_PENDING')
  }
  const run = async (p: Proposal) => {
    try {
      check(p)
      await update(p, { state: 'running', phase: 'publish' })
      await verify(p)
      check(p)
      unlinked(dirname(p.target))
      mkdirSync(dirname(p.target), { recursive: true })
      unlinked(p.target)
      if (existsSync(p.target)) {
        const root = discovery
          .roots({
            workspaceRoot: p.authority.workspaceRoot,
            agnesHomeDir: p.authority.agnesHome,
            osHomeDir: p.authority.agnesHome,
          })
          .find((r) => r.rootKey === p.rootKey)
        if (!root) throw installError('SKILL_ROOT_UNAVAILABLE')
        const current = await readInstallBundle(p.target, root, [], discovery).catch(() => {
          throw installError('SKILL_TARGET_CONFLICT')
        })
        if (current.digest !== p.bundle.digest) throw installError('SKILL_TARGET_CONFLICT')
      } else {
        // No asynchronous gap between the live lease check and atomic publication. The synchronous
        // callback also checks cancellation/deadline while staging and immediately before rename.
        publishInstallBundle(p.target, p.bundle, () => check(p))
      }
      const candidate = p.bundle.candidate
      await update(p, { resourceId: candidate.resourceId, revision: candidate.revision })
      await effect(p, 'refresh', '_agnes/v1/skills.refresh', {
        rootKey: p.rootKey,
        workspaceId: installDigest(p.authority.workspaceRoot),
        reinstall: { resourceId: candidate.resourceId, expectedRevision: candidate.revision },
      })
      let resource = (await call(p, '_agnes/v1/resources.get', {
        resourceId: candidate.resourceId,
      })) as SkillDescriptor
      if (resource.revision !== candidate.revision || resource.stale || !resource.resolution.winner)
        throw installError('SKILL_RESOURCE_CHANGED_OR_SHADOWED')
      if ('enable' in p.invocation.input && p.invocation.input.enable) {
        await effect(p, 'trust', '_agnes/v1/skills.trust.set', {
          resourceId: candidate.resourceId,
          expectedRevision: candidate.revision,
          trust: 'trusted',
        })
        await effect(p, 'enable', '_agnes/v1/resources.desired.set', {
          resourceId: candidate.resourceId,
          expectedRevision: candidate.revision,
          state: 'enabled',
        })
        resource = (await call(p, '_agnes/v1/resources.get', {
          resourceId: candidate.resourceId,
        })) as SkillDescriptor
        if (
          resource.revision !== candidate.revision ||
          resource.stale ||
          !resource.resolution.winner ||
          resource.actual !== 'ready' ||
          resource.trust !== 'trusted' ||
          resource.desired !== 'enabled'
        )
          throw installError('SKILL_NOT_READY')
        await update(p, { state: 'ready', phase: 'complete', effective: 'next-turn' })
      } else {
        // New Skills are enabled by default; an install that did not ask for it records that choice.
        await effect(p, 'disable', '_agnes/v1/resources.desired.set', {
          resourceId: candidate.resourceId,
          expectedRevision: candidate.revision,
          state: 'disabled',
        })
        await update(p, { state: 'installed', phase: 'complete' })
      }
    } catch (error) {
      await update(p, {
        state: p.cancelled
          ? 'cancelled'
          : (error as Error).message === 'SKILL_RESOURCE_OPERATION_PENDING'
            ? 'interrupted'
            : 'failed',
        message: /^SKILL_[A-Z_]+$/.test((error as Error).message)
          ? (error as Error).message
          : 'SKILL_INSTALL_FAILED',
      }).catch(() => undefined)
    } finally {
      locks.delete(p.target.toLowerCase())
      p.busy = false
      // No source bytes survive completion. The receipt stays queryable on disk.
      proposals.delete(p.result.proposalId)
    }
  }
  return {
    async request(
      invocation: SkillInstallInvocation,
      authority: SkillInstallAuthority,
      signal: AbortSignal,
    ): Promise<SkillInstallResult> {
      authority.assertActive()
      signal.throwIfAborted()
      const input = parseInstallInput(invocation.input)
      const owner = ownerOf(invocation, authority)
      if (input.action === 'prepare' || input.action === 'prepare-content') {
        for (const [id, proposal] of proposals)
          if (!proposal.busy && proposal.expires < Date.now()) proposals.delete(id)
        if (proposals.size >= 16 || [...proposals.values()].filter((p) => p.owner === owner).length >= 2)
          throw installError('SKILL_INSTALL_BUSY')
        const rootKey = input.scope === 'user' ? 'user-agnes' : 'workspace-agnes'
        const root = discovery
          .roots({
            workspaceRoot: authority.workspaceRoot,
            agnesHomeDir: authority.agnesHome,
            osHomeDir: authority.agnesHome,
          })
          .find((r) => r.rootKey === rootKey)
        if (!root) throw installError('SKILL_ROOT_UNAVAILABLE')
        let bundle: InstallBundle
        if (input.action === 'prepare-content') {
          bundle = await inlineInstallBundle(input, root, discovery)
          for (const name of bundle.files.keys())
            assertInstallPath(invocation, join(root.path, input.name, name))
          refuseSkillTarget(join(root.path, input.name))
          await refuseSkillCollision(authority, bundle)
        } else {
          const source = unlinked(input.sourceDirectory)
          assertInstallPath(invocation, source)
          if (within(source, root.path) || within(root.path, source))
            throw installError('SKILL_SOURCE_TARGET_OVERLAP')
          const allowed = await authority.ask(
            `Read the local skill directory to prepare an install: ${source}. This only reads files and does not run scripts.`,
            installDigest(source),
            signal,
          )
          signal.throwIfAborted()
          authority.assertActive()
          if (!allowed) throw installError('SKILL_READ_REJECTED')
          bundle = await readInstallBundle(
            source,
            root,
            (path) => assertInstallPath(invocation, path),
            discovery,
          )
        }
        signal.throwIfAborted()
        authority.assertActive()
        const proposalId = `skill-install-${randomUUID()}`
        const result: SkillInstallResult = Object.freeze({
          proposalId,
          state: 'prepared',
          name: bundle.candidate.name,
          description: bundle.candidate.description,
          files: Object.freeze([...bundle.files.keys()].sort()),
          digest: bundle.digest,
          fileCount: bundle.files.size,
          scope: input.scope,
          revision: bundle.candidate.revision,
        })
        const proposal: Proposal = {
          owner,
          invocation: { ...invocation, input },
          authority,
          bundle,
          target: join(root.path, bundle.directoryName),
          rootKey,
          expires: Date.now() + 10 * 60_000,
          result,
          busy: false,
          cancelled: false,
        }
        // Approval and validation yield: reserve again before writing a receipt.
        if (proposals.size >= 16 || [...proposals.values()].filter((p) => p.owner === owner).length >= 2)
          throw installError('SKILL_INSTALL_BUSY')
        proposals.set(proposalId, proposal)
        try {
          await save(proposal)
        } catch (error) {
          proposals.delete(proposalId)
          throw error
        }
        return result
      }
      const p = proposals.get(input.proposalId)
      if (!p) {
        const file = unlinked(join(directory, `${input.proposalId}.json`))
        let stored: { owner: string; result: SkillInstallResult }
        try {
          stored = JSON.parse(boundedInstallFile(file, 65_536).toString('utf8'))
        } catch {
          throw installError('SKILL_PROPOSAL_UNAVAILABLE')
        }
        if (
          !stored ||
          stored.owner !== owner ||
          stored.result?.proposalId !== input.proposalId ||
          !['prepared', 'running', 'ready', 'installed', 'failed', 'cancelled', 'interrupted'].includes(
            stored.result.state,
          )
        )
          throw installError('SKILL_PROPOSAL_UNAVAILABLE')
        if (input.action !== 'status') throw installError('SKILL_PROPOSAL_TERMINAL')
        return ['prepared', 'running'].includes(stored.result.state)
          ? { ...stored.result, state: 'interrupted', message: 'SKILL_INSTALL_INTERRUPTED' }
          : stored.result
      }
      if (p.owner !== owner) throw installError('SKILL_PROPOSAL_UNAVAILABLE')
      if (input.action === 'status') {
        if (!p.busy && Date.now() > p.expires) {
          await update(p, { state: 'interrupted', message: 'SKILL_INSTALL_EXPIRED' })
          proposals.delete(input.proposalId)
        }
        return p.result
      }
      if (invocation.leaseId !== p.invocation.leaseId) throw installError('SKILL_INSTALL_LEASE_CHANGED')
      if (input.action === 'cancel') {
        p.cancelled = true
        if (!p.busy || p.approvalAbort) {
          const approval = p.approvalAbort
          approval?.abort(installError('SKILL_INSTALL_CANCELLED'))
          await update(p, { state: 'cancelled', message: 'SKILL_INSTALL_CANCELLED' })
          proposals.delete(input.proposalId)
        }
        return p.result
      }
      if (p.busy) return p.result
      // The commit's fresh permission, not the prepare/read grant, owns all background effects.
      p.authority = authority
      p.signal = signal
      check(p)
      p.busy = true
      let acquired = false
      try {
        const enabled = 'enable' in p.invocation.input && p.invocation.input.enable
        const source =
          p.invocation.input.action === 'prepare' ? p.invocation.input.sourceDirectory : undefined
        if (source) {
          assertInstallPath(invocation, source)
          for (const name of p.bundle.files.keys()) assertInstallPath(invocation, join(source, name))
        } else {
          for (const name of p.bundle.files.keys()) assertInstallPath(invocation, join(p.target, name))
          refuseSkillTarget(p.target)
          await refuseSkillCollision(authority, p.bundle)
        }
        const summary = `Install skill ${p.bundle.candidate.name}; source ${source ?? 'authored instruction data'}; description ${JSON.stringify(p.bundle.candidate.description)}; files ${JSON.stringify([...p.bundle.files.keys()].sort())}; target ${p.target}; ${p.bundle.files.size} files; SHA256 ${p.bundle.digest}. ${enabled ? 'Trust this version and enable it in the current profile.' : 'Register it only. Do not add trust or enable it.'}${p.rootKey === 'user-agnes' ? ' The user directory can be discovered by other profiles.' : ''} This does not overwrite different content and does not run scripts.`
        p.approvalAbort = new AbortController()
        const approvalSignal = AbortSignal.any([signal, p.approvalAbort.signal])
        try {
          const allowed = await authority.ask(summary, p.bundle.digest, approvalSignal)
          approvalSignal.throwIfAborted()
          if (!allowed) throw installError('SKILL_INSTALL_REJECTED')
        } finally {
          delete p.approvalAbort
        }
        signal.throwIfAborted()
        check(p)
        const key = p.target.toLowerCase()
        if (locks.has(key)) throw installError('SKILL_TARGET_BUSY')
        locks.add(key)
        acquired = true
        p.review = {
          principalId: authority.principalId,
          digest: p.bundle.digest,
          at: new Date().toISOString(),
        }
        await update(p, { state: 'running', phase: 'accepted' })
        const task = run(p)
        authority.background?.(task)
        return p.result
      } catch (error) {
        if (acquired) locks.delete(p.target.toLowerCase())
        p.busy = false
        if (p.cancelled || signal.aborted) {
          await update(p, { state: 'cancelled', message: 'SKILL_INSTALL_CANCELLED' })
          proposals.delete(input.proposalId)
        }
        throw error
      }
    },
  }
}
