import { ExtensionError, type ExtensionManifest, type ToolContext } from '@agnes/extension-api'

function refuse(extId: string, capability: string): never {
  throw new ExtensionError('E_CAPABILITY_UNDECLARED', `${capability} is not declared`, {
    extId,
    detail: { capability },
  })
}

function hostAllowed(url: string, declarations: readonly string[]): boolean {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  const hostname = target.hostname.toLowerCase()
  const effectivePort =
    target.port || (target.protocol === 'https:' ? '443' : target.protocol === 'http:' ? '80' : '')
  return declarations.some((declaration) => {
    const split = declaration.lastIndexOf(':')
    const hasPort = split > 0
    const declaredHost = (hasPort ? declaration.slice(0, split) : declaration).toLowerCase()
    const declaredPort = hasPort ? declaration.slice(split + 1) : undefined
    return hostname === declaredHost && (declaredPort === undefined || effectivePort === declaredPort)
  })
}

/** Projects the ambient core ToolContext down to the package manifest's runtime capabilities. */
export function capabilityToolContext(manifest: ExtensionManifest, context: ToolContext): ToolContext {
  const { capabilities: caps, id } = manifest
  const hosts = caps.network && !Array.isArray(caps.network) ? [...caps.network.hosts] : []
  const projected: ToolContext = {
    ...context,
    net: Object.freeze({
      fetchPublic(url: string, options?: { responseType: 'zip' }) {
        if (caps['network.publicRead'] !== true) refuse(id, 'network.publicRead')
        if (!context.net.fetchPublic)
          throw Object.assign(new Error('Public web retrieval is unavailable'), {
            code: 'WEB_FETCH_UNAVAILABLE',
          })
        return options ? context.net.fetchPublic(url, options) : context.net.fetchPublic(url)
      },
      fetch(url, init) {
        if (!hostAllowed(url, hosts)) refuse(id, 'network')
        return context.net.fetch(url, init)
      },
    }),
    tools: Object.freeze({
      list: () => context.tools.list(),
      invoke(name, args, opts) {
        if (caps['tools.invoke'] !== true) refuse(id, 'tools.invoke')
        return context.tools.invoke(name, args, opts)
      },
    }),
    artifacts: Object.freeze({
      put(bytes, meta) {
        if (caps.artifacts !== true) refuse(id, 'artifacts')
        return context.artifacts.put(bytes, meta)
      },
      get(ref) {
        if (caps.artifacts !== true) refuse(id, 'artifacts')
        return context.artifacts.get(ref)
      },
      submitJob(spec) {
        if (caps.artifacts !== true) refuse(id, 'artifacts')
        return context.artifacts.submitJob(spec)
      },
      poll(jobId) {
        if (caps.artifacts !== true) refuse(id, 'artifacts')
        return context.artifacts.poll(jobId)
      },
      cancel(jobId) {
        if (caps.artifacts !== true) refuse(id, 'artifacts')
        return context.artifacts.cancel(jobId)
      },
    }),
    subagent: Object.freeze({
      fork(question, opts) {
        if (caps.subagent !== true) refuse(id, 'subagent')
        return context.subagent.fork(question, opts)
      },
      spawn(task, opts) {
        if (caps.subagent !== true) refuse(id, 'subagent')
        return context.subagent.spawn(task, opts)
      },
      collect(childKey, opts) {
        if (caps.subagent !== true) refuse(id, 'subagent')
        return context.subagent.collect(childKey, opts)
      },
      cancel(childKey) {
        if (caps.subagent !== true) refuse(id, 'subagent')
        return context.subagent.cancel(childKey)
      },
      resume(childKey) {
        if (caps.subagent !== true) refuse(id, 'subagent')
        return context.subagent.resume(childKey)
      },
    }),
  }
  return Object.freeze(projected)
}
