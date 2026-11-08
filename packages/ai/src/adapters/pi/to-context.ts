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
  UserMessage,
} from '@earendil-works/pi-ai'
import { toolParameters } from './tool-parameters.js'

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
    if (b.type === 'file')
      throw new Error('pi-ai has no native file input; resolve session attachments before inference')
    return { type: 'text', text: b.text }
  })
}

/** The tool a result answers is named by the call that asked for it, not by the result itself. */
function findToolName(req: RequestBody, toolUseId: string): string {
  for (const m of req.messages)
    if (m.role === 'assistant')
      for (const tc of m.toolCalls ?? []) if (tc.toolUseId === toolUseId) return tc.name
  return 'unknown'
}

function toMessage(
  m: RequestMessage,
  req: RequestBody,
  dropThinking: boolean,
  provider: string,
  replaySignature: boolean,
): Message {
  switch (m.role) {
    case 'user':
      return { role: 'user', content: contentOf(m.content), timestamp: 0 } satisfies UserMessage
    case 'assistant': {
      const content: AssistantMessage['content'] = m.content
        .filter((c) => !dropThinking || c.type !== 'thinking')
        .map((c) =>
          c.type === 'thinking'
            ? {
                type: 'thinking',
                thinking: c.text,
                // The wire library writes the reasoning back under this field name, and only when the
                // block carries it; a turn stored before signatures existed has none and replays as before.
                ...(replaySignature && c.signature ? { thinkingSignature: c.signature } : {}),
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
        // The wire library keeps a replayed thinking block only when provider, api and model all match
        // the request model, so the provider must be the one the caller gives the request model. The api
        // label stays as it is, and the signature is attached only for an openai-completions request
        // (`replaySignature`): a message's reasoning is merged into one block here, and a merged
        // encrypted signature would be refused by the provider. Not every wire protocol filters the
        // history through the api check (pi-messages posts the context as it is), so the other protocols
        // are kept from receiving a signature here rather than left to that check.
        api: 'openai-completions',
        provider,
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
 * The request, as the wire library expects to receive it. Message content is neither summarised,
 * reordered nor dropped. Tool schemas inline local root references for provider compatibility.
 * `provider` labels replayed assistant messages and defaults to the route. `replaySignature` writes
 * the stored reasoning signature back, and is off unless the caller says the request is openai-completions.
 */
export function toContext(
  req: RequestBody,
  opts: { dropThinking?: boolean; provider?: string; replaySignature?: boolean } = {},
): { context: Context; tools: Tool[] } {
  const tools: Tool[] = req.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: toolParameters(t.name, t.parameters),
  }))
  return {
    context: {
      systemPrompt: req.system,
      messages: req.messages.map((m) =>
        toMessage(
          m,
          req,
          opts.dropThinking === true,
          opts.provider ?? req.route,
          opts.replaySignature === true,
        ),
      ),
      tools,
    },
    tools,
  }
}
