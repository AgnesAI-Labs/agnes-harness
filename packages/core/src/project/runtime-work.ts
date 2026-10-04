import type { EventEnvelope, UINode } from '@agnes/protocol'
import { clipUtf16 } from './clip.js'

export type RuntimeNode = Extract<UINode, { kind: 'runtime' }>
type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {}
const string = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const bounded = (text: string, limit: number) =>
  text.length > limit ? `${clipUtf16(text, limit - 8)}\n[截断]` : text
const section = (label: string, value: unknown) =>
  `${label}\n${bounded(JSON.stringify(value, null, 2) ?? '', 2500)}`

/** Display vocabulary only. No execution adapter, provider codec or runtime dependency enters Core. */
export function runtimeWorkEvent(event: EventEnvelope) {
  if (event.type !== 'runtime/record') return
  const envelope = object(event.data)
  const runtime = object(envelope.runtime)
  const record = object(envelope.record)
  if (record.version !== 1 || !string(record.id) || !string(runtime.id) || !string(runtime.version)) return
  const kind = string(record.kind)
  if (!kind) return
  const intent = object(record.intent)
  const requestId = kind === 'model.requested' ? string(record.id) : string(record.requested)
  const intentId = kind === 'action.intended' ? string(intent.id) : string(record.intentId)
  const category: RuntimeNode['category'] | undefined =
    kind?.startsWith('model.') || kind === 'decision.selected'
      ? 'model'
      : kind?.startsWith('action.')
        ? 'action'
        : kind === 'run.stopped'
          ? 'stop'
          : undefined
  if (
    !category ||
    ![
      'model.requested',
      'model.settled',
      'decision.selected',
      'action.intended',
      'action.dispatching',
      'action.settled',
      'action.resolved',
      'run.stopped',
    ].includes(kind)
  )
    return
  const reference = category === 'model' ? requestId : category === 'action' ? intentId : string(record.id)
  if (!reference) return
  return {
    record,
    kind,
    category,
    runtime: { id: runtime.id as string, version: runtime.version as string },
    key: JSON.stringify([runtime.id, runtime.version, category, reference]),
    ...(requestId ? { requestId } : {}),
    ...(intentId ? { intentId } : {}),
  }
}

/** Same aggregation for historical replay and post-commit patches; IDs retain their first seq. */
export class RuntimeWorkProjection {
  private readonly nodes = new Map<string, RuntimeNode>()
  private readonly details = new Map<string, Map<string, string>>()
  restore(node: RuntimeNode): void {
    const reference = node.requestId ?? node.intentId
    if (reference)
      this.nodes.set(JSON.stringify([node.runtime.id, node.runtime.version, node.category, reference]), node)
  }
  apply(event: EventEnvelope): RuntimeNode | undefined {
    const parsed = runtimeWorkEvent(event)
    if (!parsed) return
    const { key, record, category, runtime, kind, requestId, intentId } = parsed
    let node = this.nodes.get(key)
    if (!node) {
      node = {
        kind: 'runtime',
        id: `runtime:${event.seq}`,
        seq: event.seq,
        lastSeq: event.seq,
        runtime,
        category,
        status: 'unknown',
        title: '运行工作',
        summary: '尚无完整请求记录',
        ...(requestId ? { requestId } : {}),
        ...(intentId ? { intentId } : {}),
      }
      this.nodes.set(key, node)
    }
    node.lastSeq = event.seq
    let detail: string | undefined
    if (kind === 'model.requested') {
      const call = object(record.call)
      node.purpose = bounded(string(call.purpose) ?? 'model', 64)
      const model = string(call.requestedModel)
      if (model) node.model = bounded(model, 256)
      const labels: Record<string, string> = {
        decision: '决策模型',
        parameters: '参数生成',
        arbitration: '模型仲裁',
        answer: '生成回答',
      }
      node.title = labels[node.purpose] ?? '模型请求'
      node.summary = `${node.title} · ${node.model ?? '模型未标明'}`
      node.status = 'running'
      detail = section(
        '输入',
        node.purpose === 'answer'
          ? { purpose: node.purpose, model: node.model, inputCursor: call.inputCursor }
          : { purpose: node.purpose, model: node.model, input: call.input },
      )
    } else if (kind === 'model.settled') {
      const settled = object(record.settlement)
      const error = object(settled.error)
      node.status = settled.error ? 'failed' : 'completed'
      node.summary = settled.error
        ? `模型请求失败 · ${bounded(string(error.code) ?? 'UNKNOWN', 64)}`
        : '模型请求已完成'
      // Missing request evidence cannot authorize exposing an answer payload either.
      detail = section('输出', {
        ...(node.purpose && node.purpose !== 'answer' ? { output: settled.output } : {}),
        observedModel: settled.observedModel,
        routing: settled.routing,
        usage: settled.usage,
        latencyMs: settled.latencyMs,
        ...(settled.error
          ? { error: { code: error.code, message: error.message, retryable: error.retryable } }
          : {}),
      })
    } else if (kind === 'decision.selected') {
      node.summary = bounded(
        `采用路径：${string(record.phase) ?? '?'} → ${string(record.operation) ?? '?'}${requestId ? '' : '（请求未关联）'}`,
        1024,
      )
      detail = section('采用路径', {
        phase: record.phase,
        operation: record.operation,
        candidateId: record.candidateId,
        confidence: record.confidence,
        source: record.source,
        escalation: record.escalation,
      })
    } else if (kind === 'action.intended') {
      const intent = object(record.intent)
      node.title = bounded(`动作准备 · ${string(intent.tool) ?? 'tool'}`, 256)
      node.status = 'waiting'
      node.summary = '动作意图已持久化，等待授权与派发'
      detail = section('动作意图', {
        decision: record.decision,
        tool: intent.tool,
        arguments: intent.arguments,
        effectClass: intent.effectClass,
      })
    } else if (kind === 'action.dispatching') {
      node.status = 'running'
      node.summary = '派发屏障已提交；等待执行结果'
    } else if (kind === 'action.settled') {
      const outcome = object(record.outcome)
      node.status =
        record.effect === 'unknown'
          ? 'unknown'
          : outcome.kind === 'success'
            ? 'completed'
            : outcome.kind === 'cancelled'
              ? 'cancelled'
              : 'failed'
      node.summary = bounded(
        `动作结算：${string(outcome.kind) ?? 'unknown'} · effect: ${string(record.effect) ?? 'unknown'}`,
        1024,
      )
      detail = section('执行证据', {
        outcome: outcome.kind,
        effect: record.effect,
        errorCode: object(outcome.error).code,
        errorMessage: object(outcome.error).message,
      })
    } else if (kind === 'action.resolved') {
      node.status =
        record.resolution === 'confirmed_applied'
          ? 'completed'
          : record.resolution === 'confirmed_not_applied'
            ? 'cancelled'
            : 'unknown'
      node.summary = bounded(`动作核验：${string(record.resolution) ?? 'unknown'}`, 1024)
      detail = section('核验', { resolution: record.resolution, evidence: record.evidence })
    } else if (kind === 'run.stopped') {
      node.title = '运行停止'
      node.status =
        record.reason === 'completed'
          ? 'completed'
          : record.reason === 'cancelled'
            ? 'cancelled'
            : record.reason === 'blocked'
              ? 'unknown'
              : 'failed'
      node.summary = bounded(`运行结果：${string(record.reason) ?? 'unknown'}`, 1024)
      detail = section('停止证据', {
        reason: record.reason,
        detail: record.detail,
        unresolved: record.unresolved,
      })
    }
    if (detail) {
      const sections = this.details.get(key) ?? new Map<string, string>()
      sections.set(kind, detail)
      this.details.set(key, sections)
      // At most three independently bounded stages; a long input cannot displace the final facts.
      node.detail = bounded([...sections.values()].join('\n\n'), 8192)
    }
    return node
  }
}
