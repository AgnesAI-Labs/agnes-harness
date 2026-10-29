import { AsyncLocalStorage } from 'node:async_hooks'

// Authority belongs to an invocation and its exact filesystem, never to a shared fence. A
// delegated child may share its parent's filesystem while having a different permission mode.
const access = new AsyncLocalStorage<Readonly<{ fs: object; enabled: () => boolean }>>()

export function withSessionFileAccess<T>(fs: object, enabled: () => boolean, invoke: () => T): T {
  return access.run({ fs, enabled }, invoke)
}

export function sessionHasFullFileAccess(fs: object): boolean {
  const current = access.getStore()
  return current?.fs === fs && current.enabled()
}
