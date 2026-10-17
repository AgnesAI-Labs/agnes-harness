/** Portable, bounded v1 data contract. Imports are evidence, never authorization. */
export const COMPONENTS = ['prompt', 'tools', 'fixture', 'model', 'loop', 'skills', 'pins']
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`
  return JSON.stringify(value)
}
export function bounded(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 1048576)
    throw new Error('E_EVAL_SIZE')
  return JSON.parse(text)
}
const obj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const strings = (v) =>
  Array.isArray(v) && v.length <= 100 && v.every((s) => typeof s === 'string' && s.length <= 4096)
export function outputMatches(output, expected) {
  if (typeof expected === 'string') return output === expected
  try {
    return canonical(JSON.parse(output)) === canonical(expected.json)
  } catch {
    return false
  }
}
const fail = () => {
  throw new Error('E_EVAL_SCHEMA')
}
export function dataset(raw) {
  const d = bounded(raw)
  if (
    !obj(d) ||
    d.schemaVersion !== 1 ||
    typeof d.id !== 'string' ||
    !d.id ||
    d.id.length > 128 ||
    !['scripted', 'strict', 'sequence'].includes(d.replay) ||
    !obj(d.hashes) ||
    !COMPONENTS.every((k) => /^[a-f0-9]{64}$/.test(d.hashes[k])) ||
    !(d.seed === null || Number.isSafeInteger(d.seed)) ||
    !obj(d.budget) ||
    !Number.isInteger(d.budget.wallMs) ||
    d.budget.wallMs < 1 ||
    d.budget.wallMs > 60000 ||
    !(d.budget.tokens === null || (Number.isSafeInteger(d.budget.tokens) && d.budget.tokens > 0)) ||
    !Array.isArray(d.cases) ||
    d.cases.length > 100
  )
    fail()
  const ids = new Set()
  for (const c of d.cases) {
    if (
      !obj(c) ||
      typeof c.id !== 'string' ||
      !c.id ||
      c.id.length > 128 ||
      ids.has(c.id) ||
      typeof c.input !== 'string' ||
      c.input.length > 32768 ||
      !obj(c.expected) ||
      !(
        typeof c.expected.output === 'string' ||
        (obj(c.expected.output) &&
          Object.keys(c.expected.output).length === 1 &&
          Object.hasOwn(c.expected.output, 'json'))
      ) ||
      !strings(c.expected.requiredTools) ||
      !strings(c.expected.allowedTools) ||
      !Array.isArray(c.expected.effects) ||
      c.expected.effects.length > 100
    )
      fail()
    ids.add(c.id)
  }
  return d
}
export function report(raw) {
  const r = bounded(raw)
  if (
    !obj(r) ||
    r.schemaVersion !== 1 ||
    r.kind !== 'agnes.eval' ||
    typeof r.datasetHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(r.datasetHash) ||
    !obj(r.dataset) ||
    !Array.isArray(r.cases)
  )
    fail()
  const d = dataset(r.dataset)
  if (
    r.cases.length > d.cases.length ||
    typeof r.cancelled !== 'boolean' ||
    typeof r.variant !== 'string' ||
    !r.variant ||
    r.variant.length > 128
  )
    fail()
  const ids = new Set()
  for (const c of r.cases) {
    if (
      !obj(c) ||
      !d.cases.some((v) => v.id === c.id) ||
      ids.has(c.id) ||
      ![0, 1].includes(c.executed) ||
      !obj(c.checks) ||
      !['structure', 'effects', 'budget'].every((k) => ['pass', 'fail', 'unknown'].includes(c.checks[k])) ||
      !obj(c.judge) ||
      !['pass', 'fail', 'unknown', 'skipped'].includes(c.judge.status) ||
      !(c.judge.tokens === null || (Number.isSafeInteger(c.judge.tokens) && c.judge.tokens >= 0)) ||
      !(c.judge.cost === null || (Number.isFinite(c.judge.cost) && c.judge.cost >= 0)) ||
      !(c.tokens === null || (Number.isSafeInteger(c.tokens) && c.tokens >= 0)) ||
      typeof c.output !== 'string' ||
      !strings(c.tools) ||
      !Array.isArray(c.effects)
    )
      fail()
    ids.add(c.id)
    const expected = d.cases.find((v) => v.id === c.id).expected
    if (
      !outputMatches(c.output, expected.output) ||
      !expected.requiredTools.every((t) => c.tools.includes(t))
    )
      c.checks.structure = 'fail'
    if (
      c.tools.some((t) => !expected.allowedTools.includes(t)) ||
      canonical(c.effects) !== canonical(expected.effects)
    )
      c.checks.effects = 'fail'
    if (d.budget.tokens !== null)
      c.checks.budget = c.tokens === null ? 'unknown' : c.tokens > d.budget.tokens ? 'fail' : c.checks.budget
  }
  // Ignore caller-supplied totals/verdicts; derive the outcome from case evidence.
  return { ...r, dataset: d, ...summarize(d, r.cases, r.cancelled), evidence: 'imported-unverified' }
}
export function summarize(d, cases, cancelled) {
  const executed = cases.reduce((n, c) => n + c.executed, 0)
  const passed = cases.filter(
    (c) =>
      c.executed === 1 &&
      Object.values(c.checks).every((s) => s === 'pass') &&
      ['pass', 'skipped'].includes(c.judge.status),
  ).length
  return {
    executed,
    passed,
    total: d.cases.length,
    status:
      !cancelled && executed > 0 && executed === d.cases.length && passed === executed ? 'pass' : 'fail',
  }
}
export const datasetInputs = (d) => ({ schemaVersion: d.schemaVersion, id: d.id, cases: d.cases })
export function compare(left, right) {
  const a = report(left),
    b = report(right)
  if (
    a.datasetHash !== b.datasetHash ||
    canonical(datasetInputs(a.dataset)) !== canonical(datasetInputs(b.dataset))
  )
    throw new Error('E_EVAL_DATASET_MISMATCH')
  return {
    schemaVersion: 1,
    kind: 'agnes.eval.comparison',
    datasetHash: a.datasetHash,
    baseline: a,
    candidate: b,
    bindings: { baseline: a.dataset, candidate: b.dataset },
    differences: a.dataset.cases.map((c) => ({
      id: c.id,
      baseline: a.cases.find((v) => v.id === c.id) ?? null,
      candidate: b.cases.find((v) => v.id === c.id) ?? null,
    })),
  }
}
