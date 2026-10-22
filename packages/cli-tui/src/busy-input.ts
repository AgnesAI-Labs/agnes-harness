import type { Session } from '@agnes/sdk'
import { tt } from './locale-extended.js'

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Cancels the session's running turn, whichever client started it: the daemon only checks that the caller
 * owns the session. A refusal comes back as readable text; any other failure is thrown.
 */
export async function cancelTurn(session: Session, locale: string): Promise<string | undefined> {
  try {
    await session.cancel()
  } catch (error) {
    const code = codeOf(error)
    // The turn ended between the keypress and the daemon seeing it: nothing is left to cancel.
    if (code === 'CONTROL_NOT_RUNNING') return undefined
    if (code === 'CAPABILITY_DENIED') return tt('busy.cancelDenied', locale)
    if ((error as { rpc?: { message?: unknown } } | null)?.rpc?.message === 'SEMANTIC_REJECTED' && code)
      return tt('busy.cancelRejected', locale, { code })
    throw error
  }
  return undefined
}
