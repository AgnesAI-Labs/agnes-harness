import { stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { satisfiesApiRange } from '@agnes/extension-api'
import { readImportJson } from '@agnes/package-manager'
import type { McpServerDefinitionInput } from '@agnes/protocol'
import { skillEnvironment } from './skill-environment.js'

export async function mcpEnvironment(
  root: string,
  definitions: readonly McpServerDefinitionInput[],
  cwd: string,
  signal: AbortSignal,
) {
  const commands = definitions.flatMap((definition) =>
    definition.transport.kind === 'stdio'
      ? [
          basename(definition.transport.executable)
            .toLowerCase()
            .replace(/\.exe$/, ''),
        ]
      : [],
  )
  const files = [
    ...(commands.some((name) => ['node', 'npm', 'npx'].includes(name)) ? ['runtime.mjs'] : []),
    ...(commands.some((name) => ['python', 'python3', 'uvx'].includes(name)) ? ['runtime.py'] : []),
  ]
  const pkg = await readImportJson(root, 'package.json')
  const report = await skillEnvironment(root, files, cwd, signal)
  const engines = pkg?.engines as Record<string, unknown> | undefined
  const node = report.find((item) => item.name === 'node')
  if (node?.actual && typeof engines?.node === 'string') {
    node.required = engines.node.slice(0, 256)
    node.state = 'unknown'
    const ranges = engines.node.split('||').map((range) =>
      range
        .trim()
        .split(/\s+/)
        .map((token) => {
          const match = /^(>=|<=|>|<|\^|~|=)?(\d+)(?:\.(\d+))?$/.exec(token)
          return match ? `${match[1] ?? ''}${match[2]}.${match[3] ?? 0}.0` : token
        })
        .join(' '),
    )
    if (
      ranges.every((range) => /^(?:[\^~<>]=?|=)?\d+\.\d+\.\d+(?:\s+(?:[<>]=?|=)\d+\.\d+\.\d+)*$/.test(range))
    )
      node.state = ranges.some((range) => satisfiesApiRange(range, node.actual)) ? 'satisfied' : 'missing'
  }
  for (const command of commands.filter(
    (name) => !['node', 'npm', 'npx', 'python', 'python3'].includes(name),
  ))
    report.push({ name: command, state: 'unknown', evidence: 'declared' })
  return report.slice(0, 32)
}

/** Only directly declared scripts are checked. Launchers and provider setup remain provider-owned. */
export async function missingMcpEntry(definitions: readonly McpServerDefinitionInput[]) {
  for (const definition of definitions) {
    const transport = definition.transport
    if (transport.kind !== 'stdio') continue
    const command = basename(transport.executable)
      .toLowerCase()
      .replace(/\.exe$/, '')
    const entry = transport.args[0]
    if (!['node', 'python', 'python3'].includes(command) || !entry || entry.startsWith('-')) continue
    const cwd = 'workspacePath' in definition ? definition.workspacePath : undefined
    if (!cwd) continue
    const file = await stat(resolve(cwd, entry)).catch(() => undefined)
    if (!file?.isFile()) return true
  }
  return false
}
