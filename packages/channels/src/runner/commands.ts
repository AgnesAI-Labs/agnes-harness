import { JsonRpcError, type Session } from '@agnes/sdk'

export type CommandName = 'help' | 'status' | 'new' | 'cancel' | 'preset'
export type Command = { name: CommandName; args: string[] }
export type SessionLike = Pick<Session, 'budget' | 'projectUI' | 'cancel' | 'setPreset'>

const NAMES: ReadonlySet<string> = new Set<CommandName>(['help', 'status', 'new', 'cancel', 'preset'])

const HELP = [
  '/help 本帮助',
  '/status 当前进度与费用',
  '/new 开始新会话',
  '/cancel 取消当前任务',
  '/preset <名字> 切换配方',
].join('\n')

export function parseCommand(text: string): Command | null {
  const match = /^\/([a-z]+)(?:\s+(.*))?$/.exec(text.trim())
  if (match === null || !NAMES.has(match[1] ?? '')) return null
  return {
    name: match[1] as CommandName,
    args: (match[2] ?? '').trim().split(/\s+/).filter(Boolean),
  }
}

export async function runCommand(
  command: Command,
  context: { session: SessionLike; newSession(): Promise<void> },
): Promise<string> {
  switch (command.name) {
    case 'help':
      return HELP
    case 'cancel':
      await context.session.cancel()
      return '已取消当前任务'
    case 'new':
      await context.newSession()
      return '已开始新会话'
    case 'preset': {
      const name = command.args[0]
      if (name === undefined) return '用法：/preset <名字>'
      try {
        await context.session.setPreset(name)
        return `已切换到 ${name}`
      } catch (error) {
        if (error instanceof JsonRpcError && error.code === -32008) {
          const reason = typeof error.data.reason === 'string' ? error.data.reason : error.rpc.message
          return `无法切换：${reason}`
        }
        throw error
      }
    }
    case 'status': {
      const [timeline, budget] = await Promise.all([
        context.session.projectUI(undefined, { surface: 'channel' }),
        context.session.budget(),
      ])
      const credits = budget.ledger.reduce((total, row) => total + (row.credits ?? 0), 0)
      if (timeline.opState === null) return `空闲；累计 credits ${credits}`
      const parked = timeline.opState.parked ? `，等待审批 ${timeline.opState.parked.ticket.slice(0, 6)}` : ''
      return `第 ${timeline.opState.turn} 轮第 ${timeline.opState.step} 步（${timeline.opState.phase}）${parked}；累计 credits ${credits}`
    }
  }
}
