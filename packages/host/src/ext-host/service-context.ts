import { platformView, type SeamImplementations } from '@agnes/core'
import type { Logger, ServiceContext } from '@agnes/extension-api'
import { type Decision, inspectJsonData, validateAgainst } from '@agnes/protocol'
import { Action, Decision as DecisionSchema, Target } from '@agnes/protocol/gen/authz'
import { createNetFetch } from '../adapters/net.js'
import { frozenJson } from './frozen-json.js'
import type { ServiceInvocationDeps } from './service-invocation.js'

/** Queries cannot open a side-effect path around the deferred durable effect executor. */
export function serviceContext(deps: {
  seams: SeamImplementations
  networkAllow: readonly string[]
  log: Logger
}): ServiceInvocationDeps['context'] {
  return (entry, identity, alive, workspace) => {
    const refuse = (): never => {
      throw new Error('service operation unavailable')
    }
    const read = async <T>(fn: () => Promise<T>): Promise<T> => {
      alive()
      const result = await fn()
      alive()
      return result
    }
    const artifacts = () => {
      alive()
      if (entry.manifest.capabilities.artifacts !== true) refuse()
      return deps.seams.artifacts
    }
    return Object.freeze({
      ...identity,
      actor: Object.freeze(identity.actor),
      cwd: workspace.root,
      // Facts at call time, probe live; services never get sandbox (spec 2026-09-15 §5.1).
      platform: platformView(deps.seams.platform),
      log: Object.freeze({
        debug: deps.log.debug.bind(deps.log),
        info: deps.log.info.bind(deps.log),
        warn: deps.log.warn.bind(deps.log),
        error: deps.log.error.bind(deps.log),
      }),
      exec: refuse,
      fs: Object.freeze({
        read: (path, opts) => read(() => workspace.fs().read(path, opts)),
        list: (path) => read(() => workspace.fs().list(path)),
        stat: (path) => read(() => workspace.fs().stat(path)),
        write: refuse,
      } satisfies ServiceContext['fs']),
      net: Object.freeze({
        fetch: async (url, init) => {
          alive()
          const target = new URL(url),
            caps = entry.manifest.capabilities.network
          const hosts = caps && !Array.isArray(caps) ? caps.hosts : []
          const host = target.hostname.toLowerCase(),
            port = target.port || (target.protocol === 'https:' ? '443' : '80')
          const matches = (list: readonly string[]) =>
            list.some((value) => value.toLowerCase() === host || value.toLowerCase() === `${host}:${port}`)
          if (
            !['http:', 'https:'].includes(target.protocol) ||
            target.username ||
            target.password ||
            !matches(hosts) ||
            !matches(deps.networkAllow) ||
            !['GET', 'HEAD'].includes(init?.method ?? 'GET') ||
            init?.body !== undefined
          )
            refuse()
          return createNetFetch({ signal: identity.signal, redirect: 'error' })(url, {
            method: init?.method ?? 'GET',
            ...(init?.headers ? { headers: init.headers } : {}),
            timeoutMs: Math.min(init?.timeoutMs ?? identity.timeoutMs, identity.timeoutMs),
          })
        },
      } satisfies ServiceContext['net']),
      artifacts: Object.freeze({
        get: (ref) => artifacts().get(ref),
        // Core ArtifactJob lacks public JobStatus fields. S5 owns that jobs adapter.
        poll: refuse,
        put: refuse,
        submitJob: refuse,
        cancel: refuse,
      } satisfies ServiceContext['artifacts']),
      authorize: async (action, target) => {
        alive()
        const request = inspectJsonData({ action, target })
        if (!request.ok) return refuse()
        const checkedRequest = frozenJson(request.value) as { action: typeof action; target: typeof target }
        if (
          !validateAgainst(Action, checkedRequest.action).ok ||
          !validateAgainst(Target, checkedRequest.target).ok
        )
          return refuse()
        const result = inspectJsonData(
          await deps.seams.principals.authorize(identity.actor, checkedRequest.action, checkedRequest.target),
        )
        alive()
        if (!result.ok) return refuse()
        const checked = validateAgainst<Decision>(DecisionSchema, result.value)
        return checked.ok ? checked.value : refuse()
      },
    } satisfies ServiceContext)
  }
}
