import { isAbsolute, relative, resolve } from 'node:path'
import type { ExtensionContext, ToolContext } from '@agnes/extension-api'
import type { PluginCapabilities } from '@agnes/protocol'

function matches(pattern: string, value: string): boolean {
  let p = 0,
    v = 0,
    star = -1,
    retry = 0
  while (v < value.length) {
    if (pattern[p] === '*') {
      star = p++
      retry = v
    } else if (pattern[p] === value[v]) {
      p++
      v++
    } else if (star >= 0) {
      p = star + 1
      v = ++retry
    } else return false
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}

/** Community diagnostics only: the existing sandbox/egress ports retain all enforcement. */
export function observePluginCapabilities(
  context: ToolContext,
  declarations: PluginCapabilities | undefined,
  log: ExtensionContext['log'],
): ToolContext {
  const reported = new Set<string>()
  const report = (capability: string, declared: boolean) => {
    if (declared || reported.has(capability)) return
    reported.add(capability)
    // Never log argv, paths, URLs, environment, prompts, secret names or credential values.
    log.warn(
      'Plugin used an undeclared capability; declare it in agnes.capabilities. See docs/guide/packages.md#capabilities',
      { capability },
    )
  }
  const exec = (argv: string[]) =>
    report(
      'exec',
      (declarations?.exec ?? []).some(
        (scope) => matches(scope, argv[0] ?? '') || matches(scope, (argv[0] ?? '').split('/').at(-1) ?? ''),
      ),
    )
  const net = (url: string) => {
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      /* The underlying port reports invalid URLs. */
    }
    report(
      'network',
      (declarations?.network ?? []).some((scope) => matches(scope.toLowerCase(), host.toLowerCase())),
    )
  }
  const fs = (kind: 'read' | 'write', path: string) => {
    const absolute = resolve(context.cwd, path),
      rel = relative(context.cwd, absolute)
    const paths = [
      path,
      absolute,
      ...(!rel.startsWith('..') && !isAbsolute(rel) ? [rel, `./${rel}`, `workspace/${rel}`] : []),
    ]
    report(
      `filesystem.${kind}`,
      (declarations?.filesystem?.[kind] ?? []).some((scope) => paths.some((value) => matches(scope, value))),
    )
  }
  return {
    ...context,
    ...(context.exec
      ? {
          exec: (argv, opts) => {
            exec(argv)
            return context.exec(argv, opts)
          },
        }
      : {}),
    ...(context.sandbox
      ? {
          sandbox: {
            ...context.sandbox,
            confine: (argv) => {
              exec(argv)
              return context.sandbox.confine(argv)
            },
          },
        }
      : {}),
    ...(context.net
      ? {
          net: {
            ...context.net,
            fetch: (url, init) => {
              net(url)
              return context.net.fetch(url, init)
            },
            ...(context.net.fetchPublic
              ? {
                  fetchPublic: (url: string, opts?: { responseType: 'zip' }) => {
                    net(url)
                    return context.net.fetchPublic!(url, opts)
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(context.fs
      ? {
          fs: {
            ...context.fs,
            read: (path, opts) => {
              fs('read', path)
              return context.fs.read(path, opts)
            },
            write: (path, data) => {
              fs('write', path)
              return context.fs.write(path, data)
            },
            list: (path) => {
              fs('read', path)
              return context.fs.list(path)
            },
            stat: (path) => {
              fs('read', path)
              return context.fs.stat(path)
            },
          },
        }
      : {}),
  }
}
