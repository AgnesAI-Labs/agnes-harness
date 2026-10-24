import { accessSync, closeSync, constants, existsSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'

const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
const real = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * The one PATH a server is resolved against and started with: absolute entries only (empty and relative
 * ones would resolve against the workspace), de-duplicated, minus every directory whose real path is
 * inside `roots` (workspace, session cwd, server root). The server's own children (`env node`, `go`,
 * `cargo`) therefore cannot resolve to repository-controlled binaries.
 */
export function safeEntries(searchPath: string, roots: readonly string[]): string[] {
  const guarded = roots.map(real)
  const seen = new Set<string>()
  return searchPath
    .split(delimiter)
    .filter((dir) => dir !== '' && isAbsolute(dir) && !seen.has(dir) && seen.add(dir))
    .filter((dir) => !guarded.some((root) => inside(root, real(dir))))
}

export type Resolved = { path: string } | { refused: string } | undefined

/**
 * The executable `name` as an absolute real path: the FIRST match on `entries` (from `safeEntries`),
 * nothing later. A match whose real path is inside `roots` (a symlink out of a safe directory) is
 * refused rather than skipped. The caller launches this exact path, never the bare name.
 */
export function resolveBinary(name: string, entries: readonly string[], roots: readonly string[]): Resolved {
  for (const dir of entries) {
    let path: string
    try {
      path = realpathSync(join(dir, name))
      accessSync(path, constants.X_OK)
    } catch {
      continue
    }
    return roots.map(real).some((root) => inside(root, path))
      ? { refused: `${name} resolves to ${path}, inside the workspace` }
      : { path }
  }
  return undefined
}

/**
 * The argv that runs `script` with `args`. A binary runs as is. A script with a shebang (first 256
 * bytes) is run as `[interpreter, script, ...args]` with the interpreter resolved the same safe way, so
 * `#!/usr/bin/env node` cannot pick up a node from the workspace.
 */
export function launchArgv(
  script: string,
  args: readonly string[],
  entries: readonly string[],
  roots: readonly string[],
): { argv: string[] } | { unavailable: string } {
  const head = Buffer.alloc(256)
  let length = 0
  try {
    const fd = openSync(script, 'r')
    try {
      length = readSync(fd, head, 0, 256, 0)
    } finally {
      closeSync(fd)
    }
  } catch {
    return { argv: [script, ...args] }
  }
  const first = head.subarray(0, length).toString('latin1').split(/\r?\n/)[0] ?? ''
  if (!first.startsWith('#!')) return { argv: [script, ...args] }
  const [program = '', ...rest] = first.slice(2).trim().split(/\s+/)
  let interpreter: Resolved
  let flags = rest
  if (basename(program) === 'env') {
    const at = rest.findIndex((word) => !word.startsWith('-'))
    const name = rest[at]
    interpreter = name ? resolveBinary(name, entries, roots) : undefined
    flags = at < 0 ? [] : rest.slice(at + 1)
  } else if (isAbsolute(program)) {
    interpreter = resolveBinary(basename(program), [dirname(program)], roots)
  }
  if (!interpreter || 'refused' in interpreter)
    return {
      unavailable: `${basename(script)} needs an interpreter that was not found outside the workspace (${interpreter?.refused ?? first})`,
    }
  return { argv: [interpreter.path, ...flags, script, ...args] }
}

/** The tsserver.js installed beside a typescript-language-server (by its real path), never one in the workspace. */
export function findTsserver(binary: string, workspaceRoot: string): string | undefined {
  for (let up = dirname(binary); dirname(up) !== up; up = dirname(up)) {
    const beside =
      basename(up) === 'node_modules' ? join(up, 'typescript') : join(up, 'node_modules', 'typescript')
    const tsserver = join(beside, 'lib', 'tsserver.js')
    if (existsSync(tsserver)) {
      const path = realpathSync(tsserver)
      return inside(real(workspaceRoot), path) ? undefined : path
    }
  }
  return undefined
}
