export function assistantText(data) {
  if (typeof data.text === 'string') return data.text
  return data.timeline.nodes
    .filter((node) => node.kind === 'assistant')
    .map((node) => node.text)
    .join('\n')
}

export function scoreContinuation(test, output, judgment) {
  const parse = (text) => JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
  let proposed, graded
  try {
    proposed = parse(assistantText(output))
    graded = parse(assistantText(judgment))
  } catch {
    return { name: test.name, passed: false, error: 'Invalid continuation or judgment JSON' }
  }
  if (!proposed || typeof proposed !== 'object' || !graded || typeof graded !== 'object')
    return { name: test.name, passed: false, error: 'Invalid continuation or judgment object' }
  const inert = output.tools.length === 0 && judgment.tools.length === 0
  const shape =
    typeof proposed.reply === 'string' && Array.isArray(proposed.toolCalls) && Array.isArray(proposed.plan)
  const checks = ['must', 'mustNot'].flatMap((kind) =>
    test[kind].map((criterion) => {
      const matches = Array.isArray(graded[kind])
        ? graded[kind].filter((row) => row.criterion === criterion)
        : []
      const row = matches.length === 1 ? matches[0] : undefined
      return {
        kind,
        criterion,
        passed: row?.passed === true && typeof row.evidence === 'string' && row.evidence.length > 0,
        evidence: row?.evidence ?? 'Missing or duplicate judgment',
      }
    }),
  )
  return {
    name: test.name,
    passed: inert && shape && checks.every((row) => row.passed),
    inert,
    shape,
    checks,
  }
}
