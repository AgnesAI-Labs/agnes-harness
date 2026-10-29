import type { Actor, ApprovalVerdict } from '@agnes/protocol'
import type { SessionImpl } from '../../src/step/session.js'

/** Answer the original durable tool gate through the authenticated backend command. */
export async function answerToolDecision(
  session: SessionImpl,
  index: number,
  verdict: ApprovalVerdict,
  actor: Actor,
) {
  const value = (await session.decisions.list()).filter(
    (item) => item.request.owner === 'core/tool-permission',
  )[index - 1]
  if (!value) throw new Error('missing durable tool gate')
  return session.decisions.answer(
    {
      handle: value.handle,
      revision: value.revision,
      commandId: `test:${value.handle.id}`,
      response: { option: verdict, value: null },
    },
    { actor, category: 'human', authorize() {} },
  )
}
