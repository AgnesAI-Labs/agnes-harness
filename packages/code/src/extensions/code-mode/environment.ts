import { applyVars, loadPrompt } from '../../prompts/sections.js'

/**
 * Only installation and platform facts belong in the environment section. Session identity, date,
 * model, preset, disclosure, cwd and sandbox level can differ across requests or sessions, so they
 * are rendered into the tail runtime-context message instead of the shared system prefix.
 */
export type EnvironmentFacts = {
  agnesVersion: string
  platform: string
  shell: string
}

export function renderEnvironment(facts: EnvironmentFacts): string {
  return applyVars(loadPrompt('environment'), facts)
}

/**
 * The volatile counterpart to EnvironmentFacts: everything about this specific request that can
 * differ from the previous one in the same session. runtimeSnapshotFacts() (prompts.ts) reads these
 * off OpContext on every contribute() call, and createPromptOperation's contribute() hands them to
 * core as runtimeContext.environment rather than folding them into a prompt section — core's own
 * tail-message mechanism (deriveRequest, packages/core/src/request/derive.ts) renders them as a
 * user-role message appended after the newest surface message, only when the merged runtimeContext
 * hash differs from the one the previous request in this turn carried.
 */
export type RuntimeSnapshotFacts = {
  date: string
  sessionKey: string
  model: string
  route: string
  slot: string
  preset: string
  disclosure: string
  enforcement: string
  cwd: string
  /** Sorted canonical extra directories the session may use; absent when it has none. */
  extraDirectories?: string[]
  /** The session's actual command boundary on Windows; absent on every other platform. */
  commandIsolation?: string
}

/** The one partial Windows contract; a near miss is not it. */
const WINDOWS_BOUNDARY: Readonly<Record<string, string>> = {
  contract: 'windows-write-restricted-v1',
  fileWrite: 'acl-partial',
  fileRead: 'unrestricted',
  network: 'unrestricted',
  processTree: 'job-object',
}
const isWindowsBoundary = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  Object.keys(value).length === Object.keys(WINDOWS_BOUNDARY).length &&
  Object.entries(WINDOWS_BOUNDARY).every(([key, want]) => (value as Record<string, unknown>)[key] === want)

const WINDOWS_WRITE =
  'Windows：工作区和本次临时目录使用 ACL 部分写限制，非严格路径隔离；读取与网络未隔离。受保护文件仍由文件工具检查，任意脚本不具备同等保护。' +
  '工作区内的硬链接若指向工作区外的文件（如 pnpm 存储），那些文件也可经此写入；会话的额外目录没有 ACL 写权限，命令写入那里会被拒绝访问。'
const WINDOWS_READ = 'Windows：不授予工作区或临时目录写能力；读取与网络未隔离，工具仍按只读规则使用。'
const WINDOWS_FULL = 'Windows：完全访问，命令未隔离'

/**
 * What a session's commands can actually reach on a Windows Host, from the enforcement its sandbox
 * reports. The partial contract is named only when that enforcement carries it. The full-access line
 * is for an explicit full-access session without that contract and without a full boundary: Windows
 * has no full local backend, so such a session's commands run unconfined, whether its posture reads
 * `none` or the unconfined `partial` file-only fallback. Other platforms keep the facts they had, so
 * nothing is said there.
 */
export function windowsCommandIsolation(input: {
  enforcement: Readonly<{ level: string; boundary?: unknown }>
  access: 'read-only' | 'workspace-write' | 'full-access'
  os: string
}): string | undefined {
  const { enforcement, access } = input
  if (input.os !== 'win32') return undefined
  if (enforcement.level === 'partial' && isWindowsBoundary(enforcement.boundary))
    return access === 'read-only' ? WINDOWS_READ : access === 'workspace-write' ? WINDOWS_WRITE : undefined
  if (access === 'full-access' && enforcement.boundary === undefined && enforcement.level !== 'full')
    return WINDOWS_FULL
  return undefined
}

/** Tool-use instructions are ordinary prompt text; the wire tools field supplies the names. */
export function renderTools(names: readonly string[]): string {
  return loadPrompt(names.length === 0 ? 'tools-none' : 'tools-available')
}
