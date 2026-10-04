import type { RequestBody, RequestMessage } from '@agnes/protocol'
import type {
  AssistantMessage,
  Context,
  ImageContent,
  JsonObject,
  Message,
  TextContent,
  Tool,
  ToolResultMessage,
  TSchema,
  UserMessage,
} from '@earendil-works/pi-ai'

type Blocks = Array<TextContent | ImageContent>

/**
 * Content blocks, one for one. A resource link has no counterpart on the wire protocols pi speaks,
 * so it crosses as the text that names it: dropping it would silently shorten the prompt the model
 * was meant to see, and the request hash would no longer describe what was sent.
 */
function contentOf(blocks: RequestMessage extends { content: infer C } ? C : never): Blocks {
  return blocks.map((b) => {
    if (b.type === 'image') return { type: 'image', data: b.data, mimeType: b.mimeType }
    if (b.type === 'resource_link') return { type: 'text', text: `${b.name ?? ''} ${b.uri}`.trim() }
    return { type: 'text', text: b.text }
  })
}

/** The tool a result answers is named by the call that asked for it, not by the result itself. */
function findToolName(req: RequestBody, toolUseId: string): string {
  for (const m of req.messages)
    if (m.role === 'assistant' || m.role === 'host_action')
      for (const tc of m.toolCalls ?? []) if (tc.toolUseId === toolUseId) return tc.name
  return 'unknown'
}

function toMessage(
  m: RequestMessage,
  req: RequestBody,
  dropThinking: boolean,
  reasoningField?: 'reasoning_content',
): Message {
  switch (m.role) {
    case 'system':
      return { role: 'system', content: structuredClone(m.content), timestamp: 0 }
    case 'user':
      return { role: 'user', content: contentOf(m.content), timestamp: 0 } satisfies UserMessage
    case 'host_action':
      return toMessage(
        { role: 'assistant', content: [], toolCalls: m.toolCalls },
        req,
        dropThinking,
        reasoningField,
      )
    case 'assistant': {
      const content: AssistantMessage['content'] = m.content
        .filter((c) => !dropThinking || c.type !== 'thinking')
        .map((c) =>
          c.type === 'thinking'
            ? {
                type: 'thinking',
                thinking: c.text,
                ...(reasoningField ? { thinkingSignature: reasoningField } : {}),
              }
            : { type: 'text', text: c.text },
        )
      for (const tc of m.toolCalls ?? [])
        content.push({
          type: 'toolCall',
          id: tc.toolUseId,
          name: tc.name,
          arguments: tc.args as JsonObject,
        })
      return {
        role: 'assistant',
        content,
        api: 'openai-completions',
        provider: req.route,
        model: req.model,
        stopReason: m.toolCalls?.length ? 'toolUse' : 'stop',
        // History carries no usage of its own: what a past turn cost is recorded in the ledger, and
        // repeating a number here would be a second, divergent account of it.
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: 0,
      } satisfies AssistantMessage
    }
    case 'tool_result':
      return {
        role: 'toolResult',
        toolCallId: m.toolUseId,
        toolName: findToolName(req, m.toolUseId),
        content: contentOf(m.content),
        isError: m.isError,
        timestamp: 0,
      } satisfies ToolResultMessage
  }
}

/**
 * The request, as the wire library expects to receive it. Pure and content-preserving: nothing is
 * summarised, reordered or dropped, because the stamp already committed to what would be sent and
 * anything this function invented would make that commitment false.
 */
export function toContext(
  req: RequestBody,
  opts: {
    dropThinking?: boolean
    api?: string
    supportsMidConvoSystemMessages?: boolean
    reasoningField?: 'reasoning_content'
  } = {},
): { context: Context; tools: Tool[] } {
  if (
    req.messages.some((message) => message.role === 'system') &&
    (opts.api !== 'openai-completions' || opts.supportsMidConvoSystemMessages !== true)
  )
    throw new Error('Ordered system history requires an explicitly supported OpenAI Completions model')
  // Only the explicitly verified wire path can lower Host-authored actions to tool-call pairs.
  // Keep the RequestBody unchanged, including authorship, for hashing and committed snapshots.
  const hostIds = new Set(
    req.messages.flatMap((message) =>
      message.role === 'host_action' ? message.toolCalls.map((call) => call.toolUseId) : [],
    ),
  )
  const used = new Set<string>()
  for (const [index, message] of req.messages.entries()) {
    if (message.role === 'tool_result' && hostIds.has(message.toolUseId)) {
      const call = req.messages[index - 1]
      if (call?.role !== 'host_action' || call.toolCalls[0]?.toolUseId !== message.toolUseId)
        throw new Error('Host action result must immediately follow its matching call')
    }
    if (message.role !== 'assistant' && message.role !== 'host_action') continue
    for (const call of message.toolCalls ?? []) {
      if (used.has(call.toolUseId) && hostIds.has(call.toolUseId))
        throw new Error('Host action tool-call identity is duplicated')
      used.add(call.toolUseId)
    }
    if (message.role !== 'host_action') continue
    if (opts.api !== 'openai-completions') throw new Error('Host action history is unsupported for this API')
    const call = message.toolCalls[0]
    const result = req.messages[index + 1]
    if (
      message.content.length !== 0 ||
      message.toolCalls.length !== 1 ||
      !call ||
      !call.args ||
      typeof call.args !== 'object' ||
      Array.isArray(call.args) ||
      result?.role !== 'tool_result' ||
      result.toolUseId !== call.toolUseId
    )
      throw new Error('Host action requires exactly one adjacent matching tool result')
  }
  const tools: Tool[] = req.tools.map((t) => ({
    name: t.name,
    description: t.description,
    // The disclosed schema goes over exactly as it was disclosed. pi types it as a TypeBox schema;
    // ours is plain JSON Schema, which is the same document without the compile-time brand.
    parameters: t.parameters as unknown as TSchema,
  }))
  return {
    context: {
      systemPrompt: req.system,
      messages: req.messages.map((m) => toMessage(m, req, opts.dropThinking === true, opts.reasoningField)),
      tools,
    },
    tools,
  }
}
