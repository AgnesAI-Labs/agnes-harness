import { AsyncLocalStorage } from 'node:async_hooks'
import type { SkillRuntimeInput } from '@agnes/resource-control-runtime'

/** One immutable control generation, many isolated session workspace views. */
export function workspaceSkills(
  shared: SkillRuntimeInput,
  load: (root: string) => Promise<SkillRuntimeInput>,
): SkillRuntimeInput {
  const views = new Map<string, Promise<SkillRuntimeInput>>()
  const calls = new AsyncLocalStorage<{ runtime: SkillRuntimeInput; sessionKey: string; active: boolean }>()
  const current = () => {
    const call = calls.getStore()
    return call ? (call.active ? call.runtime : undefined) : shared
  }
  const authorized = (sessionKey: string) => {
    const call = calls.getStore()
    return call?.active && call.sessionKey === sessionKey ? call.runtime : undefined
  }
  return Object.freeze({
    list: () => current()?.list() ?? [],
    // User-level roots are global, and the fence asks outside any workspace scope.
    readRoots: () => shared.readRoots?.() ?? [],
    read: (resourceId, session) =>
      authorized(session.sessionKey)?.read(resourceId, session) ?? { ok: false, code: 'UNAUTHORIZED' },
    readFile: (resourceId, revision, path, session) =>
      authorized(session.sessionKey)?.readFile(resourceId, revision, path, session) ?? {
        ok: false,
        code: 'UNAUTHORIZED',
      },
    async scopeWorkspace<T>(root: string, sessionKey: string, invoke: () => Promise<T>): Promise<T> {
      let view = views.get(root)
      if (!view) {
        view = load(root)
        views.set(root, view)
        void view.catch(() => {
          if (views.get(root) === view) views.delete(root)
        })
      }
      const call = { runtime: await view, sessionKey, active: true }
      try {
        return await calls.run(call, invoke)
      } finally {
        call.active = false
      }
    },
  } satisfies SkillRuntimeInput)
}
