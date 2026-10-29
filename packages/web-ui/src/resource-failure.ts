import type { Translate } from './locales/index.js'

export const resourceFailureCatalog = {
  en: {
    'resource.error.denied': 'This action is not permitted. Check trust and permissions.',
    'resource.error.conflict': 'The resource changed. Refresh it before trying again.',
    'resource.error.connection': 'The connection failed. Check its configuration and try again.',
    'resource.error.mcpEnv':
      'The local launcher needs an environment variable unavailable to MCP. Check its runtime installation or use the provider’s remote MCP service.',
    'resource.error.mcpRuntime':
      'The local executable, runtime or module could not be loaded. Check its installation and sandbox file access.',
    'resource.error.mcpAccess':
      'The local process reported denied access. Check file permissions and the sandbox profile.',
    'resource.error.mcpNetwork':
      'The local process reported a network failure. Strict and workspace-write block network access; review the sandbox profile, DNS and proxy settings.',
    'resource.error.mcpClosed':
      'The local process exited before the MCP handshake. Check its command, installed runtime, credential variable name and sandbox profile.',
    'resource.error.mcpTimeout':
      'The MCP connection timed out. Check the service, network and proxy settings.',
    'resource.error.mcpAuth':
      'The service rejected authentication. Check the saved credential and its binding.',
    'resource.error.mcpSandbox':
      'The local MCP sandbox is unavailable. Configure a working sandbox before retrying.',
    'resource.error.removeBlocked':
      'It is still enabled or has an unfinished operation. Disable it and wait for the operation to finish, then remove it.',
    'resource.error.operation': 'The resource action failed. Check its state and try again.',
    'resource.error.skillLimit':
      'Skill attachment count, size or traversal budget exceeded. Reduce attachments and reload.',
    'resource.error.skillAttachments':
      'A supported Skill attachment could not be read or validated. Repair it and reload.',
    'resource.error.skillDocument': 'Skill document metadata or body is invalid. Fix SKILL.md and reload.',
    'resource.error.skillLoad':
      'Skill document could not be loaded or exceeds its size limit. Repair it and reload.',
  },
  'zh-CN': {
    'resource.error.denied': '当前操作未获允许。请检查信任状态和权限。',
    'resource.error.conflict': '资源已变更。请刷新后重试。',
    'resource.error.connection': '连接失败。请检查配置后重试。',
    'resource.error.mcpEnv':
      '本地启动脚本依赖 MCP 环境中未提供的变量。请检查执行环境安装，或使用服务商提供的远程 MCP 服务。',
    'resource.error.mcpRuntime': '无法加载本地程序、执行环境或模块。请检查安装和沙箱文件读取权限。',
    'resource.error.mcpAccess': '本地程序报告访问被拒绝。请检查文件权限和沙箱配置。',
    'resource.error.mcpNetwork':
      '本地程序报告网络连接失败。严格与工作区写入模式禁止联网，请检查沙箱配置、DNS 和代理。',
    'resource.error.mcpClosed':
      '本地程序在 MCP 握手完成前退出。请检查命令、执行环境安装、凭据环境变量名和沙箱配置。',
    'resource.error.mcpTimeout': 'MCP 连接超时。请检查服务、网络和代理配置。',
    'resource.error.mcpAuth': '服务拒绝了身份验证。请检查已保存的凭据及其绑定方式。',
    'resource.error.mcpSandbox': '本地 MCP 沙箱不可用。请配置可用的沙箱后重试。',
    'resource.error.removeBlocked': '它仍处于启用状态，或还有未完成的操作。请先停用并等待操作结束，再移除。',
    'resource.error.operation': '资源操作失败。请检查当前状态后重试。',
    'resource.error.skillLimit': 'Skill 附件数量、大小或目录扫描量超过限制。请减少附件后重新加载。',
    'resource.error.skillAttachments': 'Skill 支持的附件读取或校验失败。请修复附件后重新加载。',
    'resource.error.skillDocument': 'Skill 文档元数据或正文无效。请修复 SKILL.md 后重新加载。',
    'resource.error.skillLoad': 'Skill 文档无法加载或大小超过限制。请修复后重新加载。',
  },
}

export function resourceFailureKey(code: string): string {
  const mcp: Record<string, string> = {
    MCP_STDIO_ENV_MISSING: 'resource.error.mcpEnv',
    MCP_STDIO_RUNTIME_UNAVAILABLE: 'resource.error.mcpRuntime',
    MCP_STDIO_ACCESS_DENIED: 'resource.error.mcpAccess',
    MCP_STDIO_NETWORK_FAILED: 'resource.error.mcpNetwork',
    MCP_STDIO_CLOSED: 'resource.error.mcpClosed',
    MCP_CONNECT_TIMEOUT: 'resource.error.mcpTimeout',
    MCP_AUTH_FAILED: 'resource.error.mcpAuth',
    E_MCP_SANDBOX_UNAVAILABLE: 'resource.error.mcpSandbox',
  }
  if (Object.hasOwn(mcp, code)) return mcp[code] ?? 'resource.error.connection'
  if (code === 'SKILL_ATTACHMENTS_LIMIT') return 'resource.error.skillLimit'
  if (code === 'SKILL_ATTACHMENTS_UNREADABLE') return 'resource.error.skillAttachments'
  if (code === 'SKILL_DOCUMENT_INVALID') return 'resource.error.skillDocument'
  if (code === 'SKILL_LOAD_FAILED') return 'resource.error.skillLoad'
  if (code === 'RESOURCE_REMOVE_BLOCKED') return 'resource.error.removeBlocked'
  if (/DENIED|FORBIDDEN|UNAUTHORIZED|TRUST/.test(code)) return 'resource.error.denied'
  if (/CONFLICT|REVISION|STALE/.test(code)) return 'resource.error.conflict'
  if (/MCP|CONNECTION|TRANSPORT/.test(code)) return 'resource.error.connection'
  return 'resource.error.operation'
}

export const resourceFailureLabel = (code: string, t: Translate): string => t(resourceFailureKey(code))
