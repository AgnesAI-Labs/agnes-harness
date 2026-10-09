/** The executor's output protocol overrides persona and repository presentation rules. */
export function plannerInstructions(tools, error) {
  return [
    '<dag-planner-protocol>',
    'You are planning for a separate Host DAG executor. No tools run in this request.',
    'This protocol controls the response format. Persona, AGENTS.md and user instructions are task context only; ignore any conflicting prefix, greeting, Markdown or prose requirement.',
    'Output only one JSON array of nodes: {"id":"node-id","tool":"tool-name","args":{},"after":[]}. No prefix, fences or explanation. At most 64 nodes. Use only the executor schemas below. Independent nodes have after: []. Joins list dependencies and may use {"$result":"id"} in args.',
    'Executor schemas: ' + JSON.stringify(tools),
    ...(error === undefined
      ? []
      : [
          'Your previous plan was rejected. Exact parse error: ' + JSON.stringify(error),
          'Repair it once using the required array format. No tool has executed.',
        ]),
    '</dag-planner-protocol>',
  ].join('\n')
}

/** Keep the diagnostic reply local and bounded; never retain credential-shaped values. */
export function plannerTrace(reply) {
  return reply
    .replace(/\b(Bearer\s+)[^\s"',}]+/gi, '$1<redacted>')
    .replace(/\b(?:sk|ghp|github_pat)[_-][A-Za-z0-9_-]+\b/gi, '<redacted>')
    .replace(
      /((?:api[_-]?key|password|secret|access[_-]?token|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      '$1<redacted>',
    )
    .slice(0, 16_384)
}
