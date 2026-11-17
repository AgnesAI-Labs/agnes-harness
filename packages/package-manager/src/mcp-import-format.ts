import type { Dirent } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { looksLikeSecret } from '@agnes/error-sanitization'
import { jcs, type McpServerDefinitionInput, validateResourceControlData } from '@agnes/protocol'

export const mcpImportError = (code: string): never => {
  throw Object.assign(new Error(code), { code })
}
const CONFIGS = ['.mcp.json', 'mcp.json', '.codex-plugin/mcp.json', '.claude-plugin/plugin.json']
const ROOTS = ['skills', '.agents/skills', '.claude/skills']
export async function readImportJson(
  root: string,
  path: string,
): Promise<Record<string, unknown> | undefined> {
  if (isAbsolute(path) || path.includes('\\') || path.split('/').some((p) => !p || p === '.' || p === '..'))
    return mcpImportError('MCP_PATH_INVALID')
  let cursor = root
  try {
    for (const part of path.split('/')) {
      cursor = join(cursor, part)
      if ((await lstat(cursor)).isSymbolicLink()) return mcpImportError('MCP_PATH_INVALID')
    }
    const stat = await lstat(cursor)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)
      return mcpImportError('MCP_CONFIG_INVALID')
    let result: unknown
    try {
      result = JSON.parse(await readFile(cursor, 'utf8'))
    } catch {
      return mcpImportError('MCP_CONFIG_INVALID')
    }
    if (!result || typeof result !== 'object' || Array.isArray(result))
      return mcpImportError('MCP_CONFIG_INVALID')
    return result as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return mcpImportError('MCP_CONFIG_INVALID')
  return value as Record<string, unknown>
}

/** Static declarations only; commands and plugin entry points are never evaluated. */
async function readMcpDeclarations(
  root: string,
  installedRoot: string,
  bindings: Readonly<Record<string, string>> = {},
) {
  const files: string[] = []
  const warnings = new Set<string>()
  const required = new Set<string>()
  let definitions: McpServerDefinitionInput[] | undefined
  const requiredCredentialsByServer: Record<string, string[]> = Object.create(null)
  const rootPath = (value: string) => {
    const normalized = value
      .replaceAll('${CLAUDE_PLUGIN_ROOT}', '.')
      .replaceAll('${CODEX_PLUGIN_ROOT}', '.')
      .replaceAll('${pluginRoot}', '.')
    if (
      normalized.includes('${') ||
      normalized.includes('\\') ||
      isAbsolute(normalized) ||
      normalized.split('/').includes('..')
    )
      return mcpImportError('MCP_PATH_INVALID')
    return resolve(installedRoot, normalized)
  }
  for (const path of CONFIGS) {
    const json = await readImportJson(root, path)
    if (!json || (path.endsWith('/plugin.json') && json.mcpServers === undefined)) continue
    const servers = object(json.mcpServers)
    if (!Object.keys(servers).length || Object.keys(servers).length > 16)
      return mcpImportError('MCP_CONFIG_INVALID')
    const rows: McpServerDefinitionInput[] = []
    for (const [id, raw] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
      const entry = object(raw)
      const rowCredentials: string[] = []
      if (
        Object.keys(entry).some(
          (key) =>
            ![
              'command',
              'args',
              'cwd',
              'env',
              'url',
              'type',
              'headers',
              'auth',
              'startup_timeout_sec',
            ].includes(key),
        )
      )
        return mcpImportError('MCP_CONFIG_UNSUPPORTED')
      if (entry.startup_timeout_sec !== undefined) warnings.add('MCP_HOST_TIMEOUT_APPLIES')
      const credential = (value: unknown, key: string) => {
        if (typeof value !== 'string' || !/^(?:Bearer )?\$\{(?:env:)?[A-Z][A-Z0-9_]*\}$/.test(value))
          return mcpImportError('MCP_INLINE_CREDENTIAL_REFUSED')
        const name = `${id}.${key}`
        if (!bindings[name]) {
          required.add(name)
          rowCredentials.push(name)
          return undefined
        }
        if (!/^secret:\/\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(bindings[name]))
          return mcpImportError('MCP_CREDENTIAL_INVALID')
        return bindings[name]
      }
      let definition: McpServerDefinitionInput
      if (entry.command !== undefined) {
        if (
          entry.url !== undefined ||
          entry.headers !== undefined ||
          entry.auth !== undefined ||
          (entry.type && entry.type !== 'stdio')
        )
          return mcpImportError('MCP_CONFIG_UNSUPPORTED')
        if (
          typeof entry.command !== 'string' ||
          !Array.isArray(entry.args ?? []) ||
          (entry.args as unknown[] | undefined)?.some((arg) => typeof arg !== 'string')
        )
          return mcpImportError('MCP_CONFIG_INVALID')
        const command =
          entry.command.includes('/') || entry.command.includes('${')
            ? rootPath(entry.command)
            : entry.command
        const args = ((entry.args ?? []) as string[]).map((arg) => {
          if (arg.split(/[\\/]/).includes('..')) return mcpImportError('MCP_PATH_INVALID')
          if (looksLikeSecret(arg) || /(?:token|secret|password|api[-_]?key)=/i.test(arg))
            return mcpImportError('MCP_INLINE_CREDENTIAL_REFUSED')
          if (arg.startsWith('./') || arg.includes('${')) return rootPath(arg)
          return arg
        })
        const env: Record<string, string> = Object.create(null)
        if (entry.env !== undefined)
          for (const [key, value] of Object.entries(object(entry.env))) {
            const ref = credential(value, `env.${key}`)
            if (ref) env[key] = ref
          }
        definition = {
          serverId: id,
          displayName: id,
          transport: { kind: 'stdio', executable: command, args },
          workspacePath: rootPath(typeof entry.cwd === 'string' ? entry.cwd : '.'),
          sandboxProfile: 'strict',
          secretBinding: Object.keys(env).length ? { kind: 'stdio-env', env } : { kind: 'none' },
        }
      } else {
        if (
          entry.env !== undefined ||
          entry.cwd !== undefined ||
          entry.args !== undefined ||
          typeof entry.url !== 'string' ||
          looksLikeSecret(entry.url)
        )
          return mcpImportError('MCP_CONFIG_UNSUPPORTED')
        const kind = entry.type === 'sse' ? 'sse' : 'http'
        if (entry.type && !['sse', 'http', 'streamable-http'].includes(String(entry.type)))
          return mcpImportError('MCP_CONFIG_UNSUPPORTED')
        let secretBinding: McpServerDefinitionInput['secretBinding'] = { kind: 'none' }
        if (entry.auth !== undefined) {
          if (jcs(entry.auth) !== jcs({ type: 'oauth' })) return mcpImportError('MCP_CONFIG_UNSUPPORTED')
          secretBinding = { kind: 'oauth' }
        }
        if (entry.headers !== undefined) {
          if (entry.auth !== undefined) return mcpImportError('MCP_CONFIG_UNSUPPORTED')
          const headers = Object.entries(object(entry.headers))
          if (headers.length !== 1) return mcpImportError('MCP_CONFIG_UNSUPPORTED')
          const [key, value] = headers[0]!
          const ref = credential(value, `header.${key}`)
          if (key.toLowerCase() === 'authorization') {
            if (ref) secretBinding = { kind: 'http-bearer', credentialRef: ref }
          } else if (key === 'x-api-key' || key === 'x-api-token') {
            if (ref) secretBinding = { kind: 'http-header', headerName: key, credentialRef: ref }
          } else return mcpImportError('MCP_CONFIG_UNSUPPORTED')
        }
        definition =
          kind === 'http'
            ? {
                serverId: id,
                displayName: id,
                transport: { kind: 'http', url: entry.url },
                secretBinding: secretBinding as { kind: 'none' },
              }
            : {
                serverId: id,
                displayName: id,
                transport: { kind: 'sse', url: entry.url },
                secretBinding: secretBinding as { kind: 'none' },
              }
      }
      if (!validateResourceControlData('McpServerDefinitionInput', definition).ok)
        return mcpImportError('MCP_CONFIG_UNSUPPORTED')
      requiredCredentialsByServer[id] = rowCredentials
      rows.push(definition)
    }
    if (definitions && jcs(definitions) !== jcs(rows)) return mcpImportError('MCP_CONFIG_AMBIGUOUS')
    definitions = rows
    files.push(path)
  }
  if (!definitions) return undefined
  return {
    definitions,
    requiredCredentials: [...required].sort(),
    requiredCredentialsByServer,
    configurationFiles: files,
    warnings: [...warnings],
  }
}

async function readMcpSkills(root: string) {
  const skills: string[] = []
  for (const path of ROOTS) {
    let entries: Dirent[]
    try {
      let cursor = root
      for (const part of path.split('/')) {
        cursor = join(cursor, part)
        const stat = await lstat(cursor)
        if (!stat.isDirectory() || stat.isSymbolicLink()) return mcpImportError('MCP_PATH_INVALID')
      }
      entries = await readdir(cursor, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(entry.name)
      )
        continue
      const name = `${path}/${entry.name}`
      try {
        if ((await lstat(join(root, name, 'SKILL.md'))).isFile()) skills.push(name)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (skills.length > 16) return mcpImportError('MCP_SKILL_LIMIT')
    }
  }
  return skills.sort()
}

/** A declared connection is optional. Unsupported MCP data never becomes an executable plan. */
export async function readMcpImport(
  root: string,
  installedRoot: string,
  bindings: Readonly<Record<string, string>> = {},
) {
  let parsed: Awaited<ReturnType<typeof readMcpDeclarations>>
  let unsupported: unknown
  try {
    parsed = await readMcpDeclarations(root, installedRoot, bindings)
  } catch (error) {
    if (!/^MCP_/.test((error as { code?: string }).code ?? '')) throw error
    unsupported = error
  }
  if (!parsed && !unsupported) return undefined
  const skills = await readMcpSkills(root)
  if (unsupported) {
    if (!skills.length) throw unsupported
    return {
      definitions: [],
      skills,
      requiredCredentials: [],
      requiredCredentialsByServer: {},
      configurationFiles: [],
      warnings: ['MCP_OPTIONAL_CONFIG_UNSUPPORTED'],
    }
  }
  return { ...parsed!, skills }
}
