import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { mcpImportError } from '@agnes/package-manager'
import type { McpPlan } from './mcp-import-state.js'

// Compatibility only: preserve and clean up existing prepared installations, never create new ones.
export const runtimeBase = (plan: McpPlan) => join(dirname(dirname(plan.root)), 'runtimes', plan.id)
const insideRuntime = (root: string, path: string) => {
  const rel = relative(root, path)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../')
}

/** Runtime trees may contain internal dependency links; never follow them while hashing. */
export async function runtimeIntegrity(root: string, signal: AbortSignal) {
  const hash = createHash('sha256')
  let entries = 0,
    bytes = 0
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 48) return mcpImportError('MCP_RUNTIME_LIMIT')
    for (const name of (await readdir(directory)).sort()) {
      signal.throwIfAborted()
      if (++entries > 100000) return mcpImportError('MCP_RUNTIME_LIMIT')
      const path = join(directory, name),
        stat = await lstat(path),
        rel = relative(root, path)
      hash.update(
        JSON.stringify([
          rel,
          stat.mode,
          stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'link' : 'file',
          stat.isFile() ? stat.size : 0,
        ]),
      )
      if (stat.isSymbolicLink()) {
        const target = await realpath(path)
        if (!insideRuntime(root, target) && !/^\.venv[\\/]bin[\\/]python[0-9.]*$/.test(rel))
          return mcpImportError('MCP_PATH_INVALID')
        hash.update(JSON.stringify(await readlink(path)))
      } else if (stat.isDirectory()) await walk(path, depth + 1)
      else if (stat.isFile()) {
        bytes += stat.size
        if (stat.size > 128 * 1024 * 1024 || bytes > 1024 * 1024 * 1024)
          return mcpImportError('MCP_RUNTIME_LIMIT')
        hash.update(await readFile(path))
      } else return mcpImportError('MCP_PATH_INVALID')
    }
  }
  await walk(root, 0)
  return hash.digest('hex')
}
