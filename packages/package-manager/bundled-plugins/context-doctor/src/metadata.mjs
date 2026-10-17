/** Metadata deliberately contains no caller-controlled strings, text, names, hashes or paths. */
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)
export const emptySnapshot = () => ({ context: null, request: null, beforeCompact: null, compact: null })
const category = (id) => (id === 'agents-md' ? 'rules' : id === 'memory:index' ? 'memory' : 'other')

/** @param {import('@agnes/extension-api').HookPayloadMap['context']} payload */
export function contextMetadata(payload) {
  /** @type {Record<'rules' | 'memory' | 'other', {sections: number, characters: number, heuristicTokens: number} | null>} */
  const groups = { rules: null, memory: null, other: null }
  // Fixed category labels ensure extension-supplied ids/sources cannot disclose paths or text.
  for (const section of payload.sections) {
    const key = category(section.id)
    const group = groups[key] ?? { sections: 0, characters: 0, heuristicTokens: 0 }
    group.sections += 1
    group.characters += section.content.length
    group.heuristicTokens += Math.ceil(section.content.length / 4)
    groups[key] = group
  }
  return {
    groups,
    surface: surfaceMetadata(payload.getSurface()),
    digestNodes: count(payload.surfaceDigest.nodes),
    digestTokensEstimate: count(payload.surfaceDigest.tokensEstimate),
    // Hook order matters: later contributors may still change sections. No final-wire claim.
    coverage: 'observed-hook-input',
  }
}
/** @param {ReadonlyArray<import('@agnes/extension-api').SurfaceNode>} nodes */
export function surfaceMetadata(nodes) {
  let knownTokens = 0,
    missingEstimates = 0,
    pinned = 0,
    results = 0,
    summaries = 0
  for (const node of nodes) {
    const estimate = count(node.tokensEstimate)
    if (estimate === null) missingEstimates++
    else knownTokens += estimate
    if (node.pinned) pinned++
    if (node.type === 'tool/result') results++
    if (node.type === 'summary') summaries++
  }
  return {
    nodes: nodes.length,
    knownTokensEstimate: knownTokens,
    missingEstimates,
    pinned,
    results,
    summaries,
  }
}
/** @param {import('@agnes/extension-api').HookPayloadMap['before_request']} payload */
export function requestMetadata(payload) {
  // Slot is a public enum-like convention, but providers may supply arbitrary names: allowlist it.
  return {
    slot: ['main', 'compact', 'compaction', 'fast', 'vision'].includes(payload.request.slot)
      ? payload.request.slot
      : null,
    messageCount: count(payload.request.messageCount),
    toolNamesCount: payload.request.toolNames.length,
    maxOutputTokens: count(payload.request.maxTokens),
    // Model identifiers, sampling values and tool names may contain private endpoint/project data.
    model: null,
    contextWindow: null,
  }
}
/** @param {import('@agnes/extension-api').HookPayloadMap['before_compact']} payload */
export function beforeCompactMetadata(payload) {
  return {
    contextTokensEstimate: count(payload.contextTokens),
    contextWindow: count(payload.contextWindow),
    reserveTokens: count(payload.reserveTokens),
    reason: ['threshold', 'overflow', 'requested'].includes(payload.reason) ? payload.reason : null,
    surface: surfaceMetadata(payload.getSurface()),
  }
}
/** @param {import('@agnes/extension-api').HookPayloadMap['compact']} payload */
export function compactMetadata(payload) {
  return {
    replaceSeq: count(payload.replaceSeq),
    range: [count(payload.range[0]), count(payload.range[1])],
    tokensBeforeEstimate: count(payload.tokensBefore),
    tokensAfterEstimate: count(payload.tokensAfter),
    retainedPairs: null,
    retainedPins: null,
    offloadedBytes: null,
    omissions: null,
  }
}
/** A fixed-size latest-value projection; event origin and namespace are filtered by the Host. */
/** @returns {import("@agnes/extension-api").PluginProjectionDef<Record<string, import("@agnes/extension-api").ProjectionEvent["data"]>>} */
export function createMetadataProjection(owner) {
  const eventType = `x/${owner}/snapshot`
  return {
    inputEventTypes: [eventType],
    maxStateBytes: 32768,
    name: 'metadata',
    stateVersion: 1,
    stateSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['context', 'request', 'beforeCompact', 'compact'],
      properties: Object.fromEntries(
        ['context', 'request', 'beforeCompact', 'compact'].map((key) => [key, { type: ['object', 'null'] }]),
      ),
    },
    init: emptySnapshot,
    apply(state, event) {
      return event.type === eventType &&
        event.data &&
        typeof event.data === 'object' &&
        !Array.isArray(event.data)
        ? { ...event.data }
        : { ...state }
    },
  }
}

export const metadataProjection = createMetadataProjection('agnes/context-doctor')
