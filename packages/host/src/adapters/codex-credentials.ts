import { lstat, open } from 'node:fs/promises'
import type {
  CodexCredentialStore,
  SubscriptionCredential,
  SubscriptionCredentialStore,
  SubscriptionProviderId,
} from '@agnes/ai'
import { withConfigurationLock } from '../configuration-lock.js'
import {
  atomicWriteCredentialFile,
  CredentialStoreError,
  parseCredentialRef,
  prepareCredentialWrite,
  resolveCredentialFile,
} from './credential-files.js'
import {
  createCredentialStore,
  isSubscriptionCredential,
  type SubscriptionCredentialV2,
} from './credential-store.js'

function toPi(value: SubscriptionCredentialV2): SubscriptionCredential {
  return {
    type: 'oauth',
    access: value.access,
    refresh: value.refresh,
    expires: value.expires,
    ...(value.accountId === undefined ? {} : { accountId: value.accountId }),
    ...(value.enterpriseUrl === undefined ? {} : { enterpriseUrl: value.enterpriseUrl }),
    ...(value.availableModelIds === undefined ? {} : { availableModelIds: [...value.availableModelIds] }),
  }
}

function toStored(provider: SubscriptionProviderId, value: SubscriptionCredential): SubscriptionCredentialV2 {
  const stored: SubscriptionCredentialV2 = {
    version: 2,
    kind: 'oauth',
    provider,
    access: value.access,
    refresh: value.refresh,
    expires: value.expires,
    ...(typeof value.accountId === 'string' ? { accountId: value.accountId } : {}),
    ...(typeof value.enterpriseUrl === 'string' ? { enterpriseUrl: value.enterpriseUrl } : {}),
    ...(Array.isArray(value.availableModelIds)
      ? { availableModelIds: value.availableModelIds.filter((id): id is string => typeof id === 'string') }
      : {}),
  }
  return stored
}

/** One store instance represents one immutable subscription grant identity. */
export function subscriptionCredentials(
  root: string,
  ref: string,
  provider: SubscriptionProviderId,
): SubscriptionCredentialStore {
  if (parseCredentialRef(ref).provider !== provider) throw new CredentialStoreError(ref, 'schema')
  const store = createCredentialStore({ root })
  const read: SubscriptionCredentialStore['read'] = async () => {
    const value = await store.read(ref)
    if (!value) return undefined
    if (!isSubscriptionCredential(value, provider)) throw new CredentialStoreError(ref, 'schema')
    return toPi(value)
  }
  const locked = async <T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    await prepareCredentialWrite(root, ref, 'oauth', store.enforcement)
    const file = `${resolveCredentialFile(root, ref, 'oauth')}.lock.sqlite`
    try {
      const fd = await open(file, 'wx', 0o600)
      await fd.close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new CredentialStoreError(ref, 'not-file')
    return withConfigurationLock(file, action, { ...(signal ? { signal } : {}), timeoutMs: 30_000 })
  }
  return {
    read,
    list: async () => ((await read(provider)) ? [{ providerId: provider, type: 'oauth' }] : []),
    modify: (id, mutate, options) => {
      if (id !== provider) return Promise.reject(new CredentialStoreError(ref, 'schema'))
      return locked(async () => {
        const current = await read(provider)
        const next = await mutate(current)
        if (!next) return current
        if (next.type !== 'oauth') throw new CredentialStoreError(ref, 'schema')
        if (provider === 'openai-codex' && current?.type === 'oauth' && current.accountId !== next.accountId)
          throw new CredentialStoreError(ref, 'schema')
        const value = toStored(provider, next)
        if (!isSubscriptionCredential(value, provider)) throw new CredentialStoreError(ref, 'schema')
        await atomicWriteCredentialFile({
          root,
          ref,
          kind: 'oauth',
          contents: `${JSON.stringify(value)}\n`,
          enforcement: store.enforcement,
        })
        return next
      }, options?.signal)
    },
    delete: (id, options) => {
      if (id !== provider) return Promise.reject(new CredentialStoreError(ref, 'schema'))
      return locked(() => store.remove(ref), options?.signal)
    },
  }
}

export const codexCredentials = (root: string, ref: string): CodexCredentialStore =>
  subscriptionCredentials(root, ref, 'openai-codex')
