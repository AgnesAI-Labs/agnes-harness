import type { PreparedSideCall, SideCallResult, SideCallTarget, SideCallUsage } from '@agnes/extension-api'

export interface JudgmentAccounting {
  calls: readonly {
    invocationId: string
    target: SideCallTarget
    replayed: boolean
    dispatch: 'not-sent' | 'may-have-sent'
    usage?: SideCallUsage
  }[]
}
export function callAccounting(
  prepared: PreparedSideCall,
  result?: SideCallResult,
  replayed = false,
): JudgmentAccounting['calls'][number] {
  return {
    invocationId: prepared.invocationId,
    target: prepared.target,
    replayed: replayed || (result && 'replayed' in result ? result.replayed : false),
    dispatch:
      result?.status === 'refused'
        ? 'not-sent'
        : result?.status === 'failed'
          ? result.dispatch
          : 'may-have-sent',
    ...(result && 'usage' in result && result.usage ? { usage: result.usage } : {}),
  }
}
