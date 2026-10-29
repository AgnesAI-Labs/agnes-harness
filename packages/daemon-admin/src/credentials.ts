import { randomUUID } from 'node:crypto'
import { createCredentialStore, createFileAudit } from '@agnes/host'
import {
  automaticPermissionDecision,
  type PermissionContext,
  permissionEffectAdmission,
  rpcError,
  samePermissionContext,
  validateAgainst,
} from '@agnes/protocol'
import {
  AdminCredentialCreate,
  AdminCredentialDelete,
  type AdminCredentialMetadata,
  AdminCredentialRename,
  AdminCredentialSet,
} from '@agnes/protocol/gen/app-server'
import { type CredentialConfiguration, referencesIn } from './credential-references.js'

class CredentialAdminFailure extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

export function createCredentialAdmin(options: {
  home: string
  dataDir: string
  configurations(): Promise<CredentialConfiguration[]>
  writableStore(): Promise<boolean>
}) {
  const store = createCredentialStore({ root: options.home })
  let tail: Promise<unknown> = Promise.resolve()
  let pending = 0
  const failed = (reason: string): never => {
    throw new CredentialAdminFailure(reason)
  }
  const metadata = async (id: string): Promise<AdminCredentialMetadata> => {
    const item = (await store.listGeneric()).find((item) => item.id === id)
    if (!item) return failed('CONFIG_CREDENTIAL_NOT_FOUND')
    return { ...item, references: referencesIn(await options.configurations()).get(id) ?? [] }
  }
  async function run(
    action: 'list' | 'create' | 'set' | 'rename' | 'delete',
    input: unknown,
    actor: string,
    permission?: { context: PermissionContext; current(): Promise<PermissionContext | undefined> },
  ) {
    const deadline = Date.now() + 120_000
    const automatic = automaticPermissionDecision(permission?.context, 'credential.admin')
    const checkPermission = async () => {
      if (automatic && permission && !samePermissionContext(permission.context, await permission.current()))
        return failed('CONFIG_CREDENTIAL_CONFIRMATION_REQUIRED')
    }
    if (action === 'list') {
      const refs = referencesIn(await options.configurations())
      return {
        items: (await store.listGeneric()).map((item) => ({ ...item, references: refs.get(item.id) ?? [] })),
      }
    }
    const schema = {
      create: AdminCredentialCreate,
      set: AdminCredentialSet,
      rename: AdminCredentialRename,
      delete: AdminCredentialDelete,
    }[action]
    if (!validateAgainst(schema, input).ok) return failed('INVALID_PARAMS')
    if (!(await options.writableStore())) return failed('CONFIG_CREDENTIAL_UNAVAILABLE')
    const params = input as {
      id?: string
      label?: string
      value?: string
      force?: boolean
      confirm?: boolean
    }
    const id = action === 'create' ? `secret://generic/${randomUUID()}` : (params.id as string)
    if (action === 'create') {
      if ((await store.listGeneric()).length >= 4096) return failed('CONFIG_CREDENTIAL_STORE')
      referencesIn(await options.configurations())
    }
    const before = action === 'create' ? undefined : await metadata(id)
    if (action === 'delete') {
      if (params.force && params.confirm !== true && !automatic)
        return failed('CONFIG_CREDENTIAL_CONFIRMATION_REQUIRED')
      if (!params.force && before?.references.length) return failed('CONFIG_CREDENTIAL_REFERENCED')
    }
    await checkPermission()
    // Durable action attempt, before mutation. Never pass user labels, values, hashes or request bodies.
    const audit = createFileAudit(`${options.dataDir}/audit/credentials.jsonl`)
    audit.write({
      kind: 'credential.changed',
      detail: { actor, id, action, ...(automatic ?? {}) },
    })
    await audit.close?.()
    await checkPermission()
    const admission = automatic
      ? permissionEffectAdmission({
          expiresAt: deadline,
          unavailable: () => new CredentialAdminFailure('CONFIG_CREDENTIAL_CONFIRMATION_REQUIRED'),
          verify: checkPermission,
          // id and params are private owned snapshots, retained through the store's atomic replacement.
        })
      : undefined
    if (action === 'delete') {
      await store.remove(id, admission)
      return {}
    }
    const createdAt = before?.createdAt ?? new Date().toISOString()
    const label = params.label ?? (before?.label as string)
    const existing = action === 'rename' ? await store.read(id) : undefined
    if (action === 'rename' && existing?.kind !== 'api-key') return failed('CONFIG_CREDENTIAL_NOT_FOUND')
    await store.putGeneric(
      id,
      params.value ?? (existing as { value: string }).value,
      { label, createdAt },
      admission,
    )
    // Project only metadata. Reuse the reference read from before the write, avoiding a failed post-write response.
    return { id, label, kind: 'api-key', createdAt, references: before?.references ?? [] }
  }
  return {
    call(
      action: 'list' | 'create' | 'set' | 'rename' | 'delete',
      input: unknown,
      actor: string,
      permission?: { context: PermissionContext; current(): Promise<PermissionContext | undefined> },
    ): Promise<unknown> {
      if (pending >= 64) return Promise.reject(rpcError('OVERLOADED'))
      let owned: unknown
      try {
        owned = structuredClone(input)
      } catch {
        return Promise.reject(rpcError('INVALID_PARAMS'))
      }
      const ownedPermission = permission && { ...permission, context: structuredClone(permission.context) }
      pending++
      const task = tail.then(async () => {
        try {
          return await run(action, owned, actor, ownedPermission)
        } catch (error) {
          if (error instanceof CredentialAdminFailure && error.reason === 'INVALID_PARAMS')
            throw rpcError('INVALID_PARAMS')
          throw rpcError('SEMANTIC_REJECTED', {
            reason: error instanceof CredentialAdminFailure ? error.reason : 'CONFIG_CREDENTIAL_STORE',
          })
        } finally {
          pending--
        }
      })
      // Atomic replacement is last-writer-wins. Serialize read/modify/write to preserve labels on set.
      tail = task.catch(() => undefined)
      return task
    },
  }
}
