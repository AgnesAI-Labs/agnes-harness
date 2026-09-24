type Json = Record<string, unknown>
export type JsonSchemaDoc = Json & {
  $defs?: Record<string, Json>
  definitions?: Record<string, Json>
  $ref?: string
}

const HEADER_COMMENT = '// generated from schema by tools/gen.ts — do not edit\n'
const IMPORT_TYPE = "import { Type, type Static } from '@sinclair/typebox'\n"
const IMPORT_FORMAT_REGISTRY = "import { FormatRegistry } from '@sinclair/typebox'\n"

// JSON Schema `format` → source for a runtime check function. These are pure functions written into
// gen/ts/*.ts, so they must not import node:*.
// A declared `format` must really be registered as a check, never silently dropped: a constraint that
// a schema declares but that can never fail is worse than no constraint at all. Only 'date-time' and
// 'uri' are needed today. If a schema ever uses a format missing from this table, generateModule
// throws (fail fast), forcing an entry to be added here rather than quietly emitting a field whose
// declared constraint nothing enforces.
// 'uri' is the only format ACP hangs on a `type:'string'` node (`ElicitationUrlMode.url`). `new URL()`
// was checked against real ajv-formats (the de facto reference implementation in the JSON Schema
// ecosystem) over a representative spread of values — absolute URIs with a scheme, relative paths, the
// empty string, mailto:, urn: — and the two agree everywhere except `"http://"` (no host), which
// ajv-formats accepts and `new URL()` rejects. Recorded and deliberately not fixed: an acceptable
// simplification, not the class of hole this check exists to close.
const FORMAT_CHECKERS: Record<string, string> = {
  // Matches PackageManager's existing URL parser, including IPv6 and normalized numeric ports.
  'agnes-git-source':
    "(value) => { const raw = value.slice(4); const hashAt = raw.lastIndexOf('#'); const commit = raw.slice(hashAt + 1); try { const url = new URL(raw.slice(0, hashAt)); return value.startsWith('git:') && hashAt > 0 && /^[a-f0-9]{40}$/.test(commit) && url.protocol === 'https:' && url.username === '' && url.password === '' && url.search === '' && url.hash === ''; } catch { return false; } }",
  // Calendar-aware RFC3339 check. Unconditional local hour/minute bounds precede leap seconds;
  // installed ajv-formats full mode omits them on its leap-second path. Keep the prior wire
  // shape: T/t separator and Z/z or sign-HH:MM offsets; reference-library differences are pinned.
  // Date.parse normalizes February 30 and rejects leap seconds; neither behavior validates a date.
  'date-time':
    "(value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(parts[0] ?? ''); const time = /^(\\d{2}):(\\d{2}):(\\d{2}(?:\\.\\d+)?)(z|([+-])(\\d{2}):(\\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; }",
  uri: '(v) => { try { new URL(v); return true } catch { return false } }',
}

// The ACP schema also hangs a set of formats on `type:'integer'` / `type:'number'` nodes
// (int32/int64/uint16/uint32/uint64/double/float — Rust schemars-style numeric width hints, not
// standard values from the JSON Schema Format vocabulary). The switch in `emit()` only passes
// `format` through to `Type.String`'s options on the 'string' branch (below); the integer/number
// branches never read it, so registering FormatRegistry entries for them would be dead weight the
// generated module never consumes.
//
// Whether they must appear in FORMAT_CHECKERS therefore comes down to: does this format value carry
// verifiable semantics anywhere in the standard ecosystem? Checked against real ajv-formats —
// `uint16`/`uint32`/`uint64` are not in its format list at all (unregistered, i.e. non-existent);
// `double`/`float` are implemented as `() => true` (a literal no-op — a JS number is already an
// IEEE-754 double, there is no narrower precision to check); `int64` is just `Number.isInteger`,
// fully redundant with `type:'integer'` itself. Only `int32` adds semantics (a ±2^31 range), and none
// of the 10 methods this package references touch a field carrying `int32` (`ErrorCode`, confirmed by
// `$ref` reachability analysis).
//
// So these numeric formats are treated as annotations, the same class as `x-*` extension keys and
// `discriminator`. That is not the "silently drop a verifiable constraint" failure this fail-fast
// exists to prevent; it faithfully reflects that they carry no verifiable constraint anywhere.
// `collectFormats` only collects format values hanging off nodes that could be strings, so
// FORMAT_CHECKERS is forced to cover exactly the ones that actually get consumed.
function formatAppliesToString(node: Json): boolean {
  const t = node.type
  return t === undefined || t === 'string' || (Array.isArray(t) && (t as string[]).includes('string'))
}

// Recursively collect every `format` value appearing in a JSON Schema fragment (usually the whole
// $defs table), de-duplicated and sorted. Sorting is purely so the generated output is byte-stable
// and does not depend on traversal order. Only formats hanging off string nodes are collected — or
// off nodes with no declared type, conservatively treated as possibly strings; see
// formatAppliesToString above.
function collectFormats(
  node: unknown,
  seen: Set<unknown> = new Set(),
  out: Set<string> = new Set(),
): Set<string> {
  if (node === null || typeof node !== 'object') return out
  if (seen.has(node)) return out
  seen.add(node)
  if (Array.isArray(node)) {
    for (const n of node) collectFormats(n, seen, out)
    return out
  }
  const obj = node as Json
  if (typeof obj.format === 'string' && formatAppliesToString(obj)) out.add(obj.format)
  for (const v of Object.values(obj)) collectFormats(v, seen, out)
  return out
}

function lit(v: unknown): string {
  return typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : JSON.stringify(v)
}

function opts(s: Json, keys: string[]): string {
  const o: string[] = []
  for (const k of keys) if (s[k] !== undefined) o.push(`${k}: ${JSON.stringify(s[k])}`)
  return o.length ? `, { ${o.join(', ')} }` : ''
}

// Pure annotation keywords in the JSON Schema / OpenAPI style — none of them ever affect the boolean
// validation result. `description`/`title`/`default`/`$comment`/`examples`/`deprecated` are the
// annotation keywords defined by the 2020-12 spec. `discriminator` is not a JSON Schema keyword at
// all but an OpenAPI branch hint, handled as an unknown keyword by plain ajv/TypeBox validation and
// so equally without effect. `x-*` are upstream ACP's own extension keys used as codegen hints
// (`x-deserialize-default-on-error`, `x-method`, `x-side`), same story.
// These keys are filtered out before deciding whether a sibling of a combinator (`oneOf`/`anyOf`/
// `allOf`) really needs merging — otherwise nearly every discriminated union in the ACP schema
// (`ContentBlock`, `SessionUpdate`, ... all carry `description` + `discriminator` beside their
// `oneOf`) would be misread as an unrecognised sibling constraint and trigger fail-fast.
const ANNOTATION_KEYS = new Set([
  'description',
  'title',
  'default',
  '$comment',
  'examples',
  'deprecated',
  'discriminator',
])
function isAnnotationKey(k: string): boolean {
  return ANNOTATION_KEYS.has(k) || k.startsWith('x-')
}

// ── emit()'s leftover-key check ──────────────────────────────────────────────────────────────
// emit() used to fail-fast on only two problems (an unregistered `format`, and a combinator with
// siblings); every other keyword it did not recognise was **silently dropped**. Ten-plus of them were
// tried one by one — `patternProperties`, `minProperties`, `multipleOf`, `exclusiveMinimum`,
// `uniqueItems`, `prefixItems`, `propertyNames`, `if`+`then`, `dependentRequired`, `not`,
// `unevaluatedProperties`, plus a typo'd `maxLenght` — and every single one passed without throwing.
// The worst case was `{type:'object', patternProperties:{...}, additionalProperties:false}` becoming
// `Type.Object({}, { additionalProperties: false })`: **a validator that rejects every key**, always
// false.
//
// The fix (the same shape as emitCombinator's existing `dropped` computation): every branch of emit()
// declares the keys it **actually consumes**, and any key left over throws — except annotation keys,
// and keys that are vacuously true for the `type` this node declares under JSON Schema semantics.
// This must be an **allowlist** (which keys do I recognise) rather than a denylist (which keys do I
// forbid): nobody ever lists a typo'd keyword name like `maxLenght`, so a denylist cannot catch it.
//
// The "vacuously true for this node's type" exemption is not a compromise, it is JSON Schema 2020-12
// semantics: `maxLength` only asserts on string instances, so on `{"type":"null"}` it is **always
// true** — not generating it is correct, not a silent drop. The exemption is required in practice:
// `{"type":["string","null"], "maxLength":128}` expands into per-type branches, and the null branch
// arrives carrying maxLength.
const NUMERIC = new Set(['number', 'integer'])
const STRINGY = new Set(['string'])
const ARRAYY = new Set(['array'])
const OBJECTY = new Set(['object'])
// Keyword → the set of instance types it constrains. Keywords absent from this table
// (`const`/`enum`/`$ref`/`not`/`if`/`allOf`/...) can assert on any instance type, so they are never
// exempted.
const KEYWORD_APPLIES_TO: Record<string, ReadonlySet<string>> = {
  minLength: STRINGY,
  maxLength: STRINGY,
  pattern: STRINGY,
  format: STRINGY,
  minimum: NUMERIC,
  maximum: NUMERIC,
  exclusiveMinimum: NUMERIC,
  exclusiveMaximum: NUMERIC,
  multipleOf: NUMERIC,
  items: ARRAYY,
  prefixItems: ARRAYY,
  minItems: ARRAYY,
  maxItems: ARRAYY,
  uniqueItems: ARRAYY,
  contains: ARRAYY,
  minContains: ARRAYY,
  maxContains: ARRAYY,
  unevaluatedItems: ARRAYY,
  properties: OBJECTY,
  patternProperties: OBJECTY,
  additionalProperties: OBJECTY,
  unevaluatedProperties: OBJECTY,
  propertyNames: OBJECTY,
  required: OBJECTY,
  minProperties: OBJECTY,
  maxProperties: OBJECTY,
  dependentRequired: OBJECTY,
  dependentSchemas: OBJECTY,
}

function leftoverKeys(s: Json, consumed: readonly string[]): string[] {
  const kept = new Set(consumed)
  const t = typeof s.type === 'string' ? s.type : undefined
  return Object.keys(s).filter((k) => {
    if (isAnnotationKey(k) || kept.has(k)) return false
    const applies = KEYWORD_APPLIES_TO[k]
    return !(applies !== undefined && t !== undefined && !applies.has(t))
  })
}

function checkNoLeftoverKeys(s: Json, ctx: EmitCtx, branch: string, consumed: readonly string[]): void {
  const leftover = leftoverKeys(s, consumed)
  if (leftover.length === 0) return
  // One common case is not "the generator does not support this keyword" but "the node declares no
  // type, so no branch can consume it" — which is what happens when a combinator branch is written as
  // `{minItems:1}` or `{maxLength:10}`, a bare constraint with no type. The advice for that case is
  // completely different (add a type, rather than extend the generator), so it is spelled out
  // separately.
  const untypedKnown = s.type === undefined && leftover.every((k) => KEYWORD_APPLIES_TO[k] !== undefined)
  const advice = untypedKnown
    ? `this node declares no 'type', so no emit() branch can consume them (${leftover
        .map((k) => `${k} only asserts on ${[...(KEYWORD_APPLIES_TO[k] as ReadonlySet<string>)].join('/')}`)
        .join('; ')}) — give the node an explicit 'type', or fold the constraint into its parent`
    : `the '${branch}' branch does not consume them, so generating a module for this node would ` +
      `silently drop the constraint they express — or silently swallow a typo'd keyword name. ` +
      `Either add support for them in emit() (tools/gen-core.ts) and cover them in ` +
      `test/ajv-parity.test.ts, or register this $def in UNSUPPORTED_NODES with a documented reason`
  throw new Error(
    `unsupported schema keyword(s) [${leftover.join(', ')}] at ${ctx.path || '(root)'}: ${advice}.`,
  )
}

// `const` / `enum` pin the value down to literals, and `Type.Literal` already encodes them exactly.
// A sibling constraint on such a node is therefore either redundant (every literal satisfies it, so
// not emitting it changes no verdict) or self-contradictory (the author wrote a schema no value can
// satisfy). So these siblings are neither blindly dropped nor blindly rejected but **verified**:
// every literal must satisfy every sibling constraint we understand, while keywords we do not
// understand still throw via checkNoLeftoverKeys.
// This also fixes a defect where the enum branch ignored merged-in outer constraints, making ajv say
// false where TypeBox said true: a self-contradictory schema now throws at generation time instead of
// producing a disagreement between the two validation libraries.
function jsonTypeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}
const LITERAL_CHECKS: Record<string, (v: unknown, x: unknown) => boolean> = {
  type: (v, x) => {
    const want = Array.isArray(x) ? (x as string[]) : [String(x)]
    const got = jsonTypeOf(v)
    return want.includes(got) || (got === 'integer' && want.includes('number'))
  },
  minLength: (v, x) => typeof v !== 'string' || [...v].length >= Number(x),
  maxLength: (v, x) => typeof v !== 'string' || [...v].length <= Number(x),
  pattern: (v, x) => typeof v !== 'string' || new RegExp(String(x), 'u').test(v),
  minimum: (v, x) => typeof v !== 'number' || v >= Number(x),
  maximum: (v, x) => typeof v !== 'number' || v <= Number(x),
  exclusiveMinimum: (v, x) => typeof v !== 'number' || v > Number(x),
  exclusiveMaximum: (v, x) => typeof v !== 'number' || v < Number(x),
  multipleOf: (v, x) => typeof v !== 'number' || v % Number(x) === 0,
}

function checkLiteralNode(values: readonly unknown[], s: Json, ctx: EmitCtx, branch: string): void {
  for (const [k, check] of Object.entries(LITERAL_CHECKS)) {
    if (s[k] === undefined) continue
    const bad = values.filter((v) => !check(v, s[k]))
    if (bad.length > 0)
      throw new Error(
        `contradictory schema at ${ctx.path || '(root)'} (emit() '${branch}' branch): the sibling ` +
          `constraint ${k}=${JSON.stringify(s[k])} is violated by literal value(s) ` +
          `${bad.map((v) => JSON.stringify(v)).join(', ')} — no instance can satisfy this node. ` +
          `Fix the schema; the generator will not silently emit a type that ignores one of the two.`,
      )
  }
  checkNoLeftoverKeys(s, ctx, branch, [branch, ...Object.keys(LITERAL_CHECKS)])
}

// Nodes the generator deliberately does not implement, registered as "repo-root-relative schema file
// path + JSON pointer" so each entry names exactly one $def (the same granularity as
// `ADDITIONAL_PROPERTIES_TRUE_EXEMPT` in tools/guards/src/schema.test.ts). A node listed here is
// emitted wholesale as `Type.Unknown()` and its internal structure is never traversed by emit();
// every other node still goes through fail-fast.
// Currently only the 4 elicitation-related $defs of the ACP v1 schema. They use `not` +
// `unevaluatedProperties` to express a negative constraint ("everything except the known form/url
// variants"), and the latter remains unsupported. None of the 4 is reachable, directly or
// indirectly, by `$ref` from the 16 ACP method definitions this repo references — confirmed by `$ref`
// reachability analysis. The reason and blast radius for each are recorded in
// `schema/acp/UPSTREAM.md` and `schema/acp/DEVIATIONS.md`.
export const UNSUPPORTED_NODES: ReadonlySet<string> = new Set([
  'packages/protocol/schema/acp/schema.json#/$defs/CreateElicitationRequest',
  'packages/protocol/schema/acp/schema.json#/$defs/CreateElicitationResponse',
  'packages/protocol/schema/acp/schema.json#/$defs/ElicitationPropertySchema',
  'packages/protocol/schema/acp/schema.json#/$defs/MultiSelectItems',
])

function refName(ref: string): string {
  const m = /^#\/(?:\$defs|definitions)\/([A-Za-z0-9_]+)$/.exec(ref)
  if (!m) throw new Error(`unsupported $ref ${ref}`)
  return m[1] as string
}

// Whether a $def's schema body refers back to itself (`#/$defs/<name>`). Used to decide whether it
// has to be emitted as a standalone Type.Recursive constant — see the joint explanation on emit() and
// generateModule below.
function refsSelf(node: unknown, selfName: string, seen: Set<unknown> = new Set()): boolean {
  if (node === null || typeof node !== 'object') return false
  if (seen.has(node)) return false
  seen.add(node)
  if (Array.isArray(node)) return node.some((n) => refsSelf(n, selfName, seen))
  const obj = node as Json
  if (typeof obj.$ref === 'string' && refName(obj.$ref) === selfName) return true
  return Object.values(obj).some((v) => refsSelf(v, selfName, seen))
}

type EmitCtx = { selfName?: string; recursive: ReadonlySet<string>; path: string; defs: Record<string, Json> }

// `Type.Intersect` (like plain ajv) evaluates `additionalProperties` independently for each operand.
// If one operand declares `additionalProperties:false`, it only recognises the keys in its own
// `properties` and rejects every key contributed by the other operands as excess. This does not
// throw; it silently produces a type where each operand is closed against the others and the whole
// thing is **always false** — every legitimate payload fails validation, which is far harder to
// diagnose than an exception.
//
// When the check runs: before `emitCombinator` actually assembles `Type.Intersect([...])`, each raw
// JSON node about to become an operand gets a shallow check — the node itself, or, when it is a pure
// `$ref` (only `$ref` plus annotation keys), the `$def` it points at. If either declares
// `additionalProperties:false`, fail fast. Only one level of `$ref` is resolved: every discriminated
// union branch in both the ACP and agnes-v1 schemas has the same shape, a type shell plus a single
// `$ref`. Deeper indirection (a `$ref` target that is itself another combinator) is left for whenever
// it actually shows up.
function closedOperandDetail(node: Json, defs: Record<string, Json>): string | null {
  const keys = Object.keys(node)
  const isPureRef = typeof node.$ref === 'string' && keys.every((k) => k === '$ref' || isAnnotationKey(k))
  if (isPureRef) {
    const name = refName(String(node.$ref))
    const target = defs[name] as Json | undefined
    if (target?.additionalProperties === false) {
      return `is a bare $ref to '${name}' (#/$defs/${name}), whose target declares additionalProperties:false`
    }
    return null
  }
  if (node.additionalProperties === false) return 'declares additionalProperties:false directly'
  return null
}

function checkClosedIntersectOperand(
  node: Json,
  path: string,
  comb: 'oneOf' | 'anyOf' | 'allOf',
  defs: Record<string, Json>,
): void {
  const detail = closedOperandDetail(node, defs)
  if (detail) {
    throwUnsupportedCombinator(
      path,
      comb,
      `would become a Type.Intersect operand that ${detail} — Type.Intersect evaluates ` +
        `additionalProperties independently per operand (same as ajv), so this operand would reject ` +
        `every property contributed by the other operand(s) in the intersection, making the generated ` +
        `type permanently false for any real payload — this does NOT throw at validation time, every ` +
        `legitimate value just silently fails. Either drop additionalProperties:false from the ` +
        `referenced $def, or fold this operand's fields directly into the object shell instead of ` +
        `Intersect-ing a reference to it`,
    )
  }
}

// General sibling merging for combinators. emit() once merged outer sibling constraints correctly in
// exactly one shape, string + anyOf, and fail-fasted on every other combinator shape. That was too
// narrow: the upstream ACP schema uses the discriminated-union shape everywhere — nearly every
// polymorphic type (`ContentBlock`, `ToolCallContent`, `SessionUpdate`, `SessionConfigOption`,
// `AuthMethod`, `McpServer`, ...) is an outer object shell (`type` + `properties` + `required`)
// stacked on a `oneOf`/`anyOf`/`allOf`, with each branch stacking a further `allOf:[{$ref}]` pointing
// at the fields of a concrete variant. That is the norm, not a speculative corner case.
//
// So the rule changed from "reject them all" to "merge whatever can be merged safely, reject only
// merges that would silently drop a constraint":
//   - No non-annotation siblings (after the `isAnnotationKey` filter) → unchanged: `oneOf`/`anyOf`
//     become Type.Union, `allOf` becomes Type.Intersect. Nothing to merge.
//   - Non-annotation siblings present → emit the sibling part (`outerRest`, the original object minus
//     the combinator key) as its own schema and place it alongside each branch's emit result, either
//     inside one Type.Intersect (`allOf`) or by stacking outerRest onto each branch and then Union-ing
//     those (`oneOf`/`anyOf`). Type.Intersect is used rather than the textual `{...outer, ...b}` spread
//     that string+anyOf uses, because ACP branches are almost all `{$ref:...}` and emit() returns
//     immediately on seeing a `$ref` without looking at the other keys — a textual spread would
//     swallow outerRest whole whenever the branch carries a `$ref`. Type.Intersect (and JSON Schema
//     2020-12 itself) natively expresses "an object literal AND a $ref"; this is not a simplification
//     but the right tool for the shape.
//   - The one danger: outerRest or a branch carries nothing at all (no type/$ref/const/enum/nested
//     combinator), so emit() falls through to the switch's default and yields `Type.Unknown()`.
//     Putting that into an Intersect means AND-ing with something always true, i.e. that part of the
//     constraint is swallowed in silence — the same class of bug as a dropped format. `emitCombinator`
//     checks for this before and after merging and fail-fasts on a hit, reporting the JSON pointer
//     path, the combinator involved, the dropped sibling keys, and which side triggered it (the outer
//     object, or which branch index).
function throwUnsupportedCombinator(
  path: string,
  combinator: 'oneOf' | 'anyOf' | 'allOf',
  detail: string,
): never {
  throw new Error(
    `unsupported schema shape at ${path || '(root)'}: '${combinator}' ${detail} — generating a module for ` +
      `this shape would silently drop a constraint (the same class of bug fixed for string+anyOf and the ` +
      `general oneOf/anyOf/allOf sibling merge, see the history comments in this file).`,
  )
}

// Merge the non-annotation sibling keys beside a `oneOf`/`anyOf`/`allOf` (if any) into each branch,
// then assemble Type.Union (`oneOf`/`anyOf`) or Type.Intersect (`allOf`) depending on the combinator.
// See the design notes above.
function emitCombinator(s: Json, comb: 'oneOf' | 'anyOf' | 'allOf', ctx: EmitCtx): string {
  const branches = s[comb] as Json[]
  const outerRest: Json = { ...s }
  delete outerRest[comb]
  const dropped = Object.keys(outerRest).filter((k) => !isAnnotationKey(k))
  const branchPath = (i: number) => `${ctx.path}/${comb}/${i}`
  const emitBranch = (b: Json, i: number) => emit(b, { ...ctx, path: branchPath(i) })

  if (dropped.length === 0) {
    // A bare allOf (no siblings to merge) assembles Type.Intersect([...branches]) directly, so every
    // branch is an operand and this is where they get checked. A bare oneOf/anyOf becomes a
    // Type.Union, produces no Intersect, and needs no check.
    if (comb === 'allOf') {
      branches.forEach((b, i) => {
        checkClosedIntersectOperand(b, branchPath(i), comb, ctx.defs)
      })
    }
    const parts = branches.map((b, i) => emitBranch(b, i))
    return comb === 'allOf' ? `Type.Intersect([${parts.join(', ')}])` : `Type.Union([${parts.join(', ')}])`
  }

  // dropped.length > 0: outerRest and every branch will become an operand of some Type.Intersect —
  // allOf puts them all in one Intersect, oneOf/anyOf stacks outerRest onto each branch to form one
  // Intersect per branch (see the return below). Either way neither outerRest nor any branch escapes,
  // so all of them are checked.
  checkClosedIntersectOperand(outerRest, ctx.path, comb, ctx.defs)
  branches.forEach((b, i) => {
    checkClosedIntersectOperand(b, branchPath(i), comb, ctx.defs)
  })

  // There used to be a `guard()` here checking whether outerRest or a branch had emitted as the
  // always-true `Type.Unknown()` (a bare constraint node with no type/$ref/const/enum). Once every
  // branch of emit() gained the leftover-key check it became **unreachable**: emit() only returns
  // Type.Unknown() from its default branch, and that branch now throws first if any non-annotation
  // key remains. It was dead code and was removed. Fail-fast for this shape is carried by
  // checkNoLeftoverKeys's `untypedKnown` branch, which reports both better advice ("give this node a
  // type" rather than "extend the generator") and a deeper JSON pointer (down to /anyOf/0).
  const outerSrc = emit(outerRest, ctx)
  const branchSrcs = branches.map((b, i) => emitBranch(b, i))
  if (comb === 'allOf') return `Type.Intersect([${outerSrc}, ${branchSrcs.join(', ')}])`
  return `Type.Union([${branchSrcs.map((b) => `Type.Intersect([${outerSrc}, ${b}])`).join(', ')}])`
}

/**
 * Emit the one dependentRequired shape this repository currently needs: a symmetric all-or-none
 * group. TypeBox 0.34 serialises the keyword but Value.Check ignores it, so passing it through as an
 * object option would make the generated runtime validator weaker than AJV. Expanding the same
 * assertion into an absent branch and a complete branch keeps the source schema idiomatic, keeps
 * generated static properties discoverable, and gives both validators identical semantics.
 */
function emitAllOrNoneDependentRequired(s: Json, ctx: EmitCtx): string {
  const raw = s.dependentRequired
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(`unsupported dependentRequired at ${ctx.path || '(root)'}: expected an object`)
  const deps = raw as Record<string, unknown>
  const keys = Object.keys(deps)
  if (keys.length < 2)
    throw new Error(
      `unsupported dependentRequired at ${ctx.path || '(root)'}: all-or-none groups need at least two keys`,
    )
  const keySet = new Set(keys)
  for (const key of keys) {
    const list = deps[key]
    const expected = keys.filter((candidate) => candidate !== key).sort()
    if (
      !Array.isArray(list) ||
      list.some((value) => typeof value !== 'string') ||
      new Set(list).size !== list.length ||
      list.some((value) => !keySet.has(value as string)) ||
      [...(list as string[])].sort().join('\0') !== expected.join('\0')
    )
      throw new Error(
        `unsupported dependentRequired at ${ctx.path || '(root)'}: only a symmetric all-or-none group is implemented`,
      )
  }
  const { dependentRequired: _dependentRequired, ...base } = s
  const present = keys.map((key) => ({
    type: 'object',
    required: [key],
    properties: { [key]: {} },
  }))
  const absent = { not: { anyOf: present } }
  const complete = {
    type: 'object',
    required: keys,
    properties: Object.fromEntries(keys.map((key) => [key, {}])),
  }
  // Intersecting the original closed object with this assertion is safe: both conditional branches
  // only test presence and contribute no new property names. Keeping the base object outside the
  // union also preserves its precise PATTERN/RANGE errors instead of masking every unrelated field
  // failure behind TypeBox's generic Union error.
  return `Type.Intersect([${emit(base, ctx)}, Type.Union([${emit(absent, { ...ctx, path: `${ctx.path}/dependentRequired/absent` })}, ${emit(complete, { ...ctx, path: `${ctx.path}/dependentRequired/complete` })}])])`
}
// Recap of the hazard this merging carries, now guarded. The merge expresses "AND" via
// Type.Intersect, and TypeBox (like plain ajv) evaluates `additionalProperties` independently per
// operand: an operand declaring `additionalProperties:false` recognises only the keys in its own
// `properties` and rejects every key contributed by the other operands, so the merged type is always
// false for any real payload. This is the general JSON Schema allOf + additionalProperties:false
// trap, not a bug specific to this generator, but its consequence is more insidious than an
// exception: nothing is reported, every legitimate payload just fails validation.
// This was originally only a "noted, not fixed" comment, on the grounds that the ACP v1 schema
// contains zero occurrences of `additionalProperties:false` and session-v1.ts zero Intersects, so it
// genuinely could not fire. But agnes-v1.json — our own schema, where a guard requires every object
// except dictionaries to be closed, and where discriminated unions are near-certain — was almost
// guaranteed to hit it, so the fail-fast went in rather than waiting to be bitten. See
// `closedOperandDetail` / `checkClosedIntersectOperand` above and the two call sites in
// `emitCombinator`.

// $ref expansion strategy, settled by experiment (both candidate routes were tried):
//   - Cross-def references that are not self-loops: Type.Module supports these natively, resolving
//     lazily by name — expand to Type.Ref('Name').
//   - A def referring to itself (JsonValue's object/array branches point recursively back at
//     JsonValue): writing Type.Ref('JsonValue') straight into Type.Module({...}) makes TypeScript
//     report "Type instantiation is excessively deep and possibly infinite" at the Static<> stage
//     (reproduced with tsc -b). Wrapping the self-looping branch in Type.Recursive((This) => ...)
//     solves the TS side, but putting that Recursive into Type.Module's defs table and having other
//     defs reach it via Type.Ref('JsonValue') makes Value.Check throw `TypeDereferenceError: Unable
//     to dereference schema with $id 'T0'` as soon as it actually walks the recursive branch — the
//     internal $id Recursive carries collides with the $id Module reassigns per key (reproduced at
//     runtime, reproducible on 0.34.33).
//     The formulation that satisfies TypeScript and the runtime at once: lift the self-referencing
//     def out of Type.Module({...}) and emit it as a standalone
//     `export const JsonValue = Type.Recursive((This) => ...)`. Other defs in the module then do not
//     reach it via Type.Ref('JsonValue') — that is the module's by-name lookup and JsonValue is no
//     longer in the table — but inline the JsonValue variable itself at the property position
//     (TypeBox allows literal TSchema values and Type.Ref to be mixed inside one Type.Object({...})).
//     Hence:
//       - referring to itself (selfName matches) → 'This'
//       - referring to a def already classed as a standalone Recursive constant → a bare identifier
//         (e.g. JsonValue)
//       - everything else → Type.Ref('Name')
function emit(s: Json, ctx: EmitCtx): string {
  if (typeof s !== 'object' || s === null)
    throw new Error(`schema must be an object at ${ctx.path || '(root)'}`)
  // `not` is an assertion on every type. Keep its siblings as a separate assertion rather
  // than letting the early const/enum/ref branches drop either half of the intersection.
  if (s.not !== undefined) {
    const { not, ...rest } = s
    const negative = `Type.Not(${emit(not as Json, { ...ctx, path: `${ctx.path}/not` })})`
    if (Object.keys(rest).every(isAnnotationKey)) return negative
    return `Type.Intersect([${emit(rest, ctx)}, ${negative}])`
  }
  if (s.$ref) {
    // In JSON Schema 2020-12 the siblings of a `$ref` are an implicit AND (no longer ignored as in
    // draft-07), but emit() returns immediately on seeing a `$ref`, which would drop any real sibling
    // constraint. So anything left beyond annotation keys fail-fasts here.
    checkNoLeftoverKeys(s, ctx, '$ref', ['$ref'])
    const name = refName(String(s.$ref))
    if (name === ctx.selfName) return 'This'
    if (ctx.recursive.has(name)) return name
    return `Type.Ref(${lit(name)})`
  }
  if (s.const !== undefined) {
    checkLiteralNode([s.const], s, ctx, 'const')
    return `Type.Literal(${lit(s.const)})`
  }
  if (Array.isArray(s.enum)) {
    checkLiteralNode(s.enum as unknown[], s, ctx, 'enum')
    return `Type.Union([${(s.enum as unknown[]).map((v) => `Type.Literal(${lit(v)})`).join(', ')}])`
  }
  if (Array.isArray(s.oneOf)) return emitCombinator(s, 'oneOf', ctx)
  if (Array.isArray(s.anyOf) && !s.type) return emitCombinator(s, 'anyOf', ctx)
  if (Array.isArray(s.allOf)) return emitCombinator(s, 'allOf', ctx)
  if (Array.isArray(s.type))
    return `Type.Union([${(s.type as string[]).map((t) => emit({ ...s, type: t }, ctx)).join(', ')}])`
  // By this point s.oneOf / s.allOf cannot be present (they were handled or thrown on above). The one
  // combinator that may still be here is s.anyOf: the check above only intercepts it when !s.type, so
  // it slips through when s.type is set. Only the 'string' branch handles it correctly (merging the
  // outer constraints, see below); the other concrete types (array/object/null/boolean/...) never
  // look at anyOf, and reaching them would be the same silent-drop bug. Intercept it once here rather
  // than repeating the check in every case.
  if (Array.isArray(s.anyOf) && s.type !== 'string') return emitCombinator(s, 'anyOf', ctx)
  switch (s.type) {
    case 'null':
      checkNoLeftoverKeys(s, ctx, 'null', ['type'])
      return 'Type.Null()'
    case 'boolean':
      checkNoLeftoverKeys(s, ctx, 'boolean', ['type'])
      return 'Type.Boolean()'
    case 'integer':
      checkNoLeftoverKeys(s, ctx, 'integer', ['type', 'minimum', 'maximum'])
      return `Type.Integer(${opts(s, ['minimum', 'maximum']).replace(/^, /, '')})`
    case 'number':
      checkNoLeftoverKeys(s, ctx, 'number', ['type', 'minimum', 'maximum'])
      return `Type.Number(${opts(s, ['minimum', 'maximum']).replace(/^, /, '')})`
    case 'string': {
      // 'format' is passed down to Type.String, and generateModule emits FormatRegistry registration
      // code for every format in use (see FORMAT_CHECKERS / collectFormats at the top of this file).
      // An earlier draft dropped format entirely, reasoning that TypeBox's FormatRegistry starts
      // empty so an unregistered format would fail valid values too. But that leaves a declared
      // constraint that can never fail, which is worse than not declaring it: register, do not drop.
      const STRING_KEYS = ['type', 'minLength', 'maxLength', 'pattern', 'format']
      checkNoLeftoverKeys(s, ctx, 'string', Array.isArray(s.anyOf) ? [...STRING_KEYS, 'anyOf'] : STRING_KEYS)
      const o = opts(s, ['minLength', 'maxLength', 'pattern', 'format']).replace(/^, /, '')
      if (Array.isArray(s.anyOf)) {
        // An anyOf on a string (EventEnvelope.type is enum ∪ pattern, with maxLength:128 on the
        // outside) must merge the outer constraints into each branch before emitting — excluding
        // anyOf itself, or the recursion never ends. The old code emitted the whole thing as a Union
        // and threw the outer constraints away. In JSON Schema, sibling constraints beside an anyOf
        // are an implicit AND, and only (outer ∧ b1) ∨ (outer ∧ b2) ∨ ... is equivalent to
        // outer ∧ (b1 ∨ b2 ∨ ...).
        // The defect this caused, caught by differential testing against ajv: a 208-character
        // extension event type string that matched the pattern branch but violated maxLength:128 was
        // judged VALID, where ajv judged it INVALID. Cases in gen.test.ts and validate.test.ts now
        // pin this.
        // The enum branch is an exception. Its branches are already concrete literals of fixed
        // length, so an outer maxLength cannot be violated even though it is not merged in — unless
        // the author wrote a self-contradictory schema, e.g. a minLength longer than one of the enum
        // literals, which is the author's error and not what this guards. Letting outer override the
        // enum branch is therefore fine: emit() checks `enum` before `type` and the other
        // string-specific keys, so once the merged object carries an `enum` field it goes straight to
        // a Type.Literal union and the remaining keys (including the merged-in outer.maxLength) are
        // ignored. That is deliberate, not an oversight.
        const { anyOf: _anyOfBranches, ...outer } = s
        return `Type.Union([${(s.anyOf as Json[]).map((b) => emit({ ...outer, ...b }, ctx)).join(', ')}])`
      }
      return `Type.String(${o})`
    }
    case 'array':
      checkNoLeftoverKeys(s, ctx, 'array', ['type', 'items', 'minItems', 'maxItems', 'uniqueItems'])
      return `Type.Array(${emit((s.items as Json) ?? {}, { ...ctx, path: `${ctx.path}/items` })}${opts(s, ['minItems', 'maxItems', 'uniqueItems'])})`
    case 'object': {
      if (s.dependentRequired !== undefined) return emitAllOrNoneDependentRequired(s, ctx)
      const props = (s.properties as Record<string, Json>) ?? {}
      const required = new Set((s.required as string[]) ?? [])
      if (
        !s.properties &&
        required.size === 0 &&
        s.additionalProperties &&
        typeof s.additionalProperties === 'object'
      ) {
        const valueSrc = emit(s.additionalProperties as Json, {
          ...ctx,
          path: `${ctx.path}/additionalProperties`,
        })
        // A dictionary whose keys are themselves constrained, spelled `propertyNames: {pattern}`.
        // The emitted form is Type.Record with a patterned key AND additionalProperties:false,
        // because TypeBox's Type.Record compiles a patterned key to `patternProperties` alone,
        // which by itself constrains nothing: a key that does not match simply falls through to the
        // absent additionalProperties and is accepted. Measured on 0.34.33 — without the closing
        // option, `{'X-Agnes-Session': 'x'}` passes a Record keyed `^X-Ext-`. With it, the key is
        // rejected, which is what the schema says and what ajv does for propertyNames.
        const names = s.propertyNames as Json | undefined
        if (names !== undefined) {
          checkNoLeftoverKeys(s, ctx, 'object (keyed dict)', [
            'type',
            'additionalProperties',
            'propertyNames',
            'minProperties',
            'maxProperties',
          ])
          const extra = Object.keys(names).filter((k) => k !== 'pattern' && !isAnnotationKey(k))
          if (typeof names.pattern !== 'string' || extra.length > 0)
            throw new Error(
              `unsupported propertyNames at ${ctx.path || '(root)'}: only a bare { pattern } is ` +
                `implemented, and generating this node would silently drop [${extra.join(', ')}].`,
            )
          return `Type.Record(Type.String({ pattern: ${lit(names.pattern)} }), ${valueSrc}${opts({ ...s, additionalProperties: false }, ['additionalProperties', 'minProperties', 'maxProperties'])})`
        }
        // Plain dictionary Record<string, T>: consumes only type + additionalProperties. This
        // branch likewise does not implement `minProperties` and friends; they fall through to
        // checkNoLeftoverKeys and throw.
        checkNoLeftoverKeys(s, ctx, 'object (dict)', ['type', 'additionalProperties'])
        return `Type.Record(Type.String(), ${valueSrc})`
      }
      // The important one, and the worst case the leftover-key check was added for:
      // `patternProperties` is not in the consumed list, so
      // `{type:'object', patternProperties:…, additionalProperties:false}` now throws instead of
      // emitting `Type.Object({}, { additionalProperties: false })` — an always-false validator that
      // rejects every key.
      checkNoLeftoverKeys(s, ctx, 'object', ['type', 'properties', 'required', 'additionalProperties'])
      // `required` may name a property that is not present in `properties`. JSON Schema uses this
      // shape for presence-only assertions (for example inside `not`), but the old emitter silently
      // dropped those names because it only iterated `properties`. Preserve the assertion with an
      // unconstrained required property. A closed object makes such a schema unsatisfiable, because
      // the required key is simultaneously forbidden, so emit Type.Never for that case instead.
      const requiredOnly = [...required]
        .filter((key) => !Object.hasOwn(props, key))
        .map((key) => {
          const value =
            s.additionalProperties === false
              ? 'Type.Never()'
              : s.additionalProperties && typeof s.additionalProperties === 'object'
                ? emit(s.additionalProperties as Json, {
                    ...ctx,
                    path: `${ctx.path}/additionalProperties`,
                  })
                : 'Type.Unknown()'
          return `${JSON.stringify(key)}: ${value}`
        })
      const body = [
        ...Object.entries(props).map(([k, v]) => {
          const childCtx = { ...ctx, path: `${ctx.path}/properties/${k}` }
          return `${JSON.stringify(k)}: ${required.has(k) ? emit(v, childCtx) : `Type.Optional(${emit(v, childCtx)})`}`
        }),
        ...requiredOnly,
      ].join(', ')
      let ap = ''
      if (s.additionalProperties === false) ap = ', { additionalProperties: false }'
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') {
        const additional = emit(s.additionalProperties as Json, {
          ...ctx,
          path: `${ctx.path}/additionalProperties`,
        })
        ap = `, { additionalProperties: ${additional} }`
      }
      return `Type.Object({ ${body} }${ap})`
    }
    default:
      // If s.anyOf were present the shared "anyOf + type !== 'string'" check above already handled
      // it (thrown, or never reaching here). Nodes land here when s.type is undefined or a type we do
      // not recognise. This branch used to be commented "no constraint to drop", which was wrong:
      // `{not:{const:'x'}}`, `{if:…,then:…}` and `{type:'foo'}` all land here and were silently
      // turned into an always-true Type.Unknown(). Now not a single key may remain beyond annotation
      // keys — a genuinely empty schema `{}` (and a node carrying only a description) still legally
      // emits Type.Unknown().
      checkNoLeftoverKeys(s, ctx, 'unknown', [])
      return 'Type.Unknown()'
  }
}

export function generateModule(schema: JsonSchemaDoc, moduleName: string, schemaFile?: string): string {
  const defs = schema.$defs ?? schema.definitions ?? {}
  const defsKey = schema.$defs ? '$defs' : 'definitions'
  const names = Object.keys(defs)
  // A $def listed in UNSUPPORTED_NODES short-circuits wholesale to Type.Unknown() and is never
  // recursed into by emit(). Even if refsSelf would class it as self-referencing, no Type.Recursive is
  // needed (Type.Unknown() has no self-reference problem). The 4 ACP elicitation $defs registered
  // today are not self-referencing, so this is a no-op for them; it keeps a correct path open for
  // future registrations that are.
  const isUnsupported = (n: string): boolean =>
    schemaFile != null && UNSUPPORTED_NODES.has(`${schemaFile}#/${defsKey}/${n}`)
  const recursive = new Set(names.filter((n) => !isUnsupported(n) && refsSelf(defs[n] as Json, n)))

  const formats = [...collectFormats(defs)].sort()
  for (const fmt of formats) {
    if (!(fmt in FORMAT_CHECKERS)) {
      throw new Error(`no FORMAT_CHECKERS entry for format '${fmt}' — add one in tools/gen-core.ts`)
    }
  }

  let out = HEADER_COMMENT + IMPORT_TYPE
  if (formats.length > 0) out += IMPORT_FORMAT_REGISTRY
  out += '\n'
  // One format may be used by several fields in a schema (several timestamp fields all using
  // 'date-time'), so register each exactly once. When no format appears at all this section is not
  // emitted, and the output carries no FormatRegistry code.
  for (const fmt of formats) {
    out += `if (!FormatRegistry.Has(${lit(fmt)})) FormatRegistry.Set(${lit(fmt)}, ${FORMAT_CHECKERS[fmt] as string})\n`
  }
  if (formats.length > 0) out += '\n'
  // Self-referencing defs are emitted first, as standalone Type.Recursive constants, in the order
  // they appear in $defs — so that by the time the Type.Module({...}) object literal below refers to
  // them, the corresponding const is already declared.
  for (const n of names) {
    if (!recursive.has(n)) continue
    out += `export const ${n} = Type.Recursive((This) => ${emit(defs[n] as Json, { selfName: n, recursive, path: `/${defsKey}/${n}`, defs: defs as Record<string, Json> })})\nexport type ${n} = Static<typeof ${n}>\n\n`
  }

  const moduleNames = names.filter((n) => !recursive.has(n))
  const entries = moduleNames
    .map(
      (n) =>
        `  ${JSON.stringify(n)}: ${isUnsupported(n) ? 'Type.Unknown()' : emit(defs[n] as Json, { recursive, path: `/${defsKey}/${n}`, defs: defs as Record<string, Json> })},`,
    )
    .join('\n')
  out += `export const ${moduleName} = Type.Module({\n${entries}\n})\n\n`
  for (const n of moduleNames) {
    out += `export const ${n} = ${moduleName}.Import(${lit(n)})\nexport type ${n} = Static<typeof ${n}>\n`
  }
  if (typeof schema.$ref === 'string') {
    out += `export const Root = ${refName(schema.$ref)}\nexport type Root = ${refName(schema.$ref)}\n`
  }
  out += emitExtras(schema)
  return out
}

// Declaration tables that live at the top level of a schema document under an `x-agnes-*` key — the
// event-type -> $def map, the hook five-tuple table, the slot table. They are data, not shapes, so
// emit() never sees them; they are copied out verbatim as frozen constants so that the validator and
// the packages downstream read the same bytes the schema declares instead of a hand-kept second copy.
// The `x-` prefix is kept in the constant name (X_AGNES_DATA, not AGNES_DATA) so the name a reader
// searches for in the schema file is the name they find in the generated module.
export function emitExtras(schema: JsonSchemaDoc): string {
  let out = ''
  for (const [key, value] of Object.entries(schema)) {
    if (!key.startsWith('x-agnes-')) continue
    const name = key.toUpperCase().replace(/-/g, '_')
    out += `export const ${name} = ${JSON.stringify(value, null, 2)} as const\n`
  }
  return out
}
