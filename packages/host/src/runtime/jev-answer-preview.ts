import { type SessionImpl, scanAll, sha256Hex } from '@agnes/core'
import type { RuntimeRecord } from '@agnes/jev-runtime'
import type { AssistantOutput, InferenceEvent } from '@agnes/protocol'

type Request = Extract<RuntimeRecord, { kind: 'model.requested' }>
type Active = {
  request: Request
  effectId: string
  seq: number
  text: string
  thinking: string
  off: () => void
}
const PREFIX = 'jev-answer:'

/** Only answer requests publish previews. Durable adoption belongs exclusively to AcceptedAnswers. */
export function createJevAnswerPreview(session: SessionImpl) {
  let active: Active | undefined
  let ending: Promise<void> | undefined
  const clear = () => {
    active?.off()
    active = undefined
  }
  const interrupted = (effectId: string, source: number, chars: AssistantOutput['chars']) =>
    session.ev(
      'assistant/output',
      { state: 'interrupted', effectId, chars, estimatedTokens: 0, content: [] },
      { origin: 'model', sourceEventSeqs: [source] },
    )
  async function finish() {
    if (ending) return ending
    const current = active
    if (!current) return
    // A failed outbox delivery may throw after the answer transaction committed. Inspect durable
    // adoption before abandoning so cleanup cannot erase an accepted answer or publish it twice.
    ending = session
      .locked(async () => {
        const messages = await scanAll((query) => session.scan(query), {
          type: 'assistant/message',
          fromSeq: current.seq + 1,
          toSeq: session.lastSeq,
        })
        if (!messages.some((row) => row.lane === session.lane && row.sourceEventSeqs?.includes(current.seq)))
          await session.d.log.append([
            interrupted(current.effectId, current.seq, {
              text: current.text.length,
              thinking: current.thinking.length,
            }),
          ])
      })
      .finally(() => {
        clear()
        ending = undefined
      })
    await ending
  }
  return {
    /** Existing output anchors are process-local previews; a new owner cannot reconstruct their text. */
    async recover() {
      const rows = await scanAll((query) => session.scan(query), {
        type: ['assistant/output', 'assistant/message'],
        toSeq: session.lastSeq,
      })
      const pending = new Map<number, { effectId: string; chars: AssistantOutput['chars'] }>()
      for (const row of rows) {
        if (row.lane !== session.lane) continue
        if (row.type === 'assistant/message') {
          for (const source of row.sourceEventSeqs ?? []) pending.delete(source)
          continue
        }
        const output = row.data as AssistantOutput
        if (!output.effectId.startsWith(PREFIX)) continue
        if (output.state === 'started')
          pending.set(row.seq, { effectId: output.effectId, chars: output.chars })
        else
          for (const [source, anchor] of pending) {
            if (anchor.effectId !== output.effectId) continue
            if (output.state === 'interrupted') pending.delete(source)
            else anchor.chars = output.chars
          }
      }
      if (pending.size)
        await session.locked(async () => {
          await session.d.log.append(
            [...pending].map(([source, anchor]) => interrupted(anchor.effectId, source, anchor.chars)),
          )
        })
    },
    async requested(request: Request, cursor: number) {
      if (request.call.purpose !== 'answer') return
      await finish()
      const effectId = `${PREFIX}${sha256Hex(JSON.stringify([session.key, session.lane, request.id]))}`
      const receipt = await session.locked(() =>
        session.d.log.append([
          session.ev(
            'assistant/output',
            { state: 'started', effectId, chars: { text: 0, thinking: 0 }, estimatedTokens: 0 },
            { origin: 'model', sourceEventSeqs: [cursor] },
          ),
        ]),
      )
      const current: Active = {
        request,
        effectId,
        seq: receipt.firstSeq,
        text: '',
        thinking: '',
        off: () => {},
      }
      active = current
      current.off = session.preview.track(effectId, () => ({
        lane: session.lane,
        effectId,
        text: current.text,
        thinking: current.thinking,
      }))
    },
    sources(request: Request): readonly number[] {
      return active?.request.id === request.id &&
        active.request.turn === request.turn &&
        active.request.step === request.step
        ? [active.seq]
        : []
    },
    event(event: Readonly<InferenceEvent>, purpose: string) {
      if (purpose !== 'answer' || !active || (event.type !== 'text_delta' && event.type !== 'thinking_delta'))
        return
      const stream = event.type === 'text_delta' ? 'text' : 'thinking'
      const offset = active[stream].length
      active[stream] += event.delta
      session.preview.publish({
        lane: session.lane,
        effectId: active.effectId,
        stream,
        offset,
        delta: event.delta,
      })
    },
    async settled(record: RuntimeRecord) {
      if (record.kind === 'model.settled' && record.requested === active?.request.id) await finish()
    },
    finish,
  }
}
