// What the live approval card says about a tool call: what it will do, the arguments it will run with,
// and what the session-wide choice covers. Pure, so the wording and the "can everything be seen"
// rule are tested without a page.

/** Characters of the arguments the card prints. Past this the card says so and drops the session grant. */
export const PREVIEW_LIMIT = 32 * 1024

/** Argument names that say what a call acts on; they lead the preview whatever order they arrived in. */
const LEADING = ['path', 'file_path', 'command', 'url', 'pattern', 'query']

export type ApprovalCard = {
  impact: string
  preview?: string
  /** Set when part of the call is not on the card. */
  warning?: string
  /** The label for "allow for the session", or undefined when that choice must not be offered. */
  sessionLabel?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function toolOf(toolCall: Record<string, unknown>): string | undefined {
  const meta = toolCall._meta
  const harness = isRecord(meta) ? meta['ai.agnes.harness'] : undefined
  const tool = isRecord(harness) ? harness.tool : undefined
  return typeof tool === 'string' && tool !== '' ? tool : undefined
}

function leadingFirst(input: unknown): unknown {
  if (!isRecord(input)) return input
  const keys = Object.keys(input)
  const first = LEADING.filter((k) => keys.includes(k))
  return Object.fromEntries([...first, ...keys.filter((k) => !first.includes(k))].map((k) => [k, input[k]]))
}

function impactOf(tool: string | undefined, kind: unknown, input: unknown): string {
  const field = (name: string): string | undefined => {
    const v = isRecord(input) ? input[name] : undefined
    return typeof v === 'string' && v !== '' ? v : undefined
  }
  const path = field('path') ?? field('file_path')
  const check = '请核对后决定。'
  if (tool === 'write') return `将创建或覆盖文件${path ? ` ${path}` : ''}。${check}`
  if (kind === 'edit') return `将修改文件${path ? ` ${path}` : ''}。${check}`
  if (kind === 'execute') return '将在此任务的工作目录执行命令。请核对命令后决定。'
  if (kind === 'fetch') return `将访问网址${field('url') ? ` ${field('url')}` : ''}。${check}`
  if (kind === 'read') return `将读取${path ? ` ${path}` : '内容'}。${check}`
  return '请核对工具及参数后决定是否继续。'
}

export function liveApprovalCard(toolCall: Record<string, unknown>): ApprovalCard {
  const tool = toolOf(toolCall)
  const input = toolCall.rawInput
  const impact = impactOf(tool, toolCall.kind, input)
  const sessionLabel = tool ? `本会话内允许所有 ${tool} 调用` : '本会话内允许此工具的所有调用'
  if (input === undefined) return { impact, sessionLabel }
  const text = JSON.stringify(leadingFirst(input), null, 2) ?? String(input)
  if (text.length <= PREVIEW_LIMIT) return { impact, preview: text, sessionLabel }
  let shown = PREVIEW_LIMIT
  const last = text.charCodeAt(shown - 1)
  if (last >= 0xd800 && last <= 0xdbff) shown -= 1
  const count = `已显示 ${shown} / 共 ${text.length} 字符`
  return {
    impact,
    preview: `${text.slice(0, shown)}\n…[${count}]`,
    warning: `内容未完整显示（${count}）。未显示的部分同样会随调用生效，所以这项审批没有“本会话允许”，只能“仅允许这次”或“拒绝”。`,
  }
}
