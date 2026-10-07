import type { LoopCheckpoint, LoopEffectStatus, ToolResult } from '@agnes/extension-api'
import type { InferenceEvent } from '@agnes/protocol'
import { scanAll } from '../log/scan-pages.js'
import { canonicalJson, sha256Hex } from '../request/hash.js'
import type { SessionImpl } from '../step/session.js'
import { CoreError } from '../types.js'

const EVENT = 'x/core/loop-invocation'
type Record = {
  invocationId: string
  fingerprint: string
  status: 'may-have-sent' | 'responded'
  checkpoint: LoopCheckpoint | null
  result?: ToolResult | readonly InferenceEvent[]
}
export class LoopInvocations {
  constructor(
    private readonly s: SessionImpl,
    private readonly checkpoint: () => LoopCheckpoint | null,
  ) {}
  private async record(id: string): Promise<Record | undefined> {
    if (!id || id.length > 256)
      throw new CoreError('E_ENVELOPE', 'invocationId must contain 1 to 256 characters')
    const rows = await scanAll((query) => this.s.d.log.scan(query), {
      type: EVENT,
      lane: this.s.lane,
      toSeq: this.s.lastSeq,
    })
    return rows
      .map((row) => row.data as unknown as Record)
      .reverse()
      .find((row) => row.invocationId === id)
  }
  async status(id: string): Promise<LoopEffectStatus> {
    const row = await this.record(id)
    if (!row) return { status: 'not-sent', invocationId: id }
    if (row.status === 'responded' && row.result !== undefined)
      return {
        status: 'responded',
        invocationId: id,
        checkpoint: row.checkpoint,
        result: structuredClone(row.result),
      }
    // A process can die after Core committed a tool response but before the driver's receipt.
    // Associate the public id with that call in its original transaction, then recover the result.
    const links = await scanAll((query) => this.s.d.log.scan(query), {
      type: 'x/core/loop-effect',
      lane: this.s.lane,
      toSeq: this.s.lastSeq,
    })
    const link = links
      .reverse()
      .find((event) => (event.data as { invocationId?: string }).invocationId === id)
    const toolUseId = (link?.data as { toolUseId?: string } | undefined)?.toolUseId
    if (toolUseId) {
      const results = await scanAll((query) => this.s.d.log.scan(query), {
        type: 'tool/result',
        lane: this.s.lane,
        toSeq: this.s.lastSeq,
      })
      const result = results
        .reverse()
        .find((event) => (event.data as { toolUseId?: string }).toolUseId === toolUseId)
      if (result) {
        const data = result.data as { content: ToolResult['content']; isError?: boolean; code?: string }
        // A recovery placeholder is uncertainty, not a real response from the external tool.
        if (data.code !== 'TOOL_OUTCOME_UNKNOWN')
          return {
            status: 'responded',
            invocationId: id,
            checkpoint: row.checkpoint,
            result: structuredClone({
              content: data.content,
              ...(data.isError === undefined ? {} : { isError: data.isError }),
            }),
          }
      }
    }
    return { status: 'may-have-sent', invocationId: id, checkpoint: row.checkpoint }
  }
  async claim(id: string, input: unknown): Promise<ToolResult | readonly InferenceEvent[] | undefined> {
    const fingerprint = sha256Hex(canonicalJson(input))
    let cached: ToolResult | readonly InferenceEvent[] | undefined
    await this.s.locked(async () => {
      const previous = await this.record(id)
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new CoreError('E_RELATION', 'invocationId was reused for a different operation')
        const recovered = await this.status(id)
        if (recovered.status !== 'responded')
          throw new CoreError(
            'E_RELATION',
            'Invocation may have been sent; reconcile its effect before replay',
            { invocationId: id },
          )
        cached = structuredClone(recovered.result)
        return
      }
      await this.s.d.log.append([
        this.s.ev(
          EVENT,
          {
            invocationId: id,
            fingerprint,
            status: 'may-have-sent',
            checkpoint: this.checkpoint(),
          },
          { ignorable: true },
        ),
      ])
    })
    return cached
  }
  async settle(id: string, input: unknown, result: ToolResult | readonly InferenceEvent[]): Promise<void> {
    await this.s.d.log.append([
      this.s.ev(
        EVENT,
        {
          invocationId: id,
          fingerprint: sha256Hex(canonicalJson(input)),
          status: 'responded',
          checkpoint: this.checkpoint(),
          result,
        },
        { ignorable: true },
      ),
    ])
  }
  async run<T extends ToolResult | readonly InferenceEvent[]>(
    id: string,
    input: unknown,
    invoke: () => Promise<T>,
  ): Promise<T> {
    const cached = await this.claim(id, input)
    if (cached !== undefined) return cached as T
    const result = await invoke()
    await this.settle(id, input, result)
    return result
  }
}
