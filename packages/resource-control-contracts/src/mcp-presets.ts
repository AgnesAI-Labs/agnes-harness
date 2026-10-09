import type { McpServerDefinitionInput } from './gen/resource-control.js'
import { validateResourceControlData } from './resource-control.js'

export const MCP_PRESETS = [
  {
    id: 'playwright',
    displayName: 'Playwright MCP',
    description: {
      en: 'Operate business websites through accessibility snapshots. Headless, with an isolated in-memory browser profile.',
      'zh-CN': '通过无障碍快照操作业务网站。默认无头运行，浏览器配置在内存中隔离。',
    },
    executable: 'npx',
    // Upstream 0.0.83 uses .playwright-mcp in a writable workspace, otherwise TMPDIR.
    // The existing network sandbox owns TMPDIR; an explicit workspace output path is read-only.
    args: ['--yes', '@playwright/mcp@0.0.83', '--headless', '--isolated'],
    sandboxProfile: 'network',
  },
] as const

/** Only constructs a definition. Saving, trust, installation and activation remain separate actions. */
export function createMcpPreset(
  presetId: string,
  options: { serverId?: string; workspacePath?: string } = {},
): McpServerDefinitionInput {
  const preset = MCP_PRESETS.find((entry) => entry.id === presetId)
  if (!preset) throw new TypeError(`Unknown MCP preset: ${presetId}`)
  const definition: McpServerDefinitionInput = {
    serverId: options.serverId ?? preset.id,
    displayName: preset.displayName,
    transport: { kind: 'stdio', executable: preset.executable, args: [...preset.args] },
    sandboxProfile: preset.sandboxProfile,
    secretBinding: { kind: 'none' },
    ...(options.workspacePath ? { workspacePath: options.workspacePath } : {}),
  }
  if (!validateResourceControlData('McpServerDefinitionInput', definition).ok)
    throw new TypeError('Invalid MCP preset definition')
  return definition
}
