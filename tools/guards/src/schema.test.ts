import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from './repo.js'

const root = repoRoot()
const schemaDir = join(root, 'packages/protocol/schema')

function listJson(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const full = join(dir, e)
    if (statSync(full).isDirectory()) out.push(...listJson(full))
    else if (e.endsWith('.json')) out.push(full)
  }
  return out
}

type SchemaPath = readonly (string | number)[]

function walk(
  node: unknown,
  path: SchemaPath,
  visit: (n: Record<string, unknown>, p: SchemaPath) => void,
): void {
  if (Array.isArray(node))
    node.forEach((c, i) => {
      walk(c, [...path, i], visit)
    })
  else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    visit(obj, path)
    for (const [k, v] of Object.entries(obj)) walk(v, [...path, k], visit)
  }
}

function jsonPointer(path: SchemaPath): string {
  if (path.length === 0) return '#'
  const escapeSegment = (segment: string | number): string =>
    String(segment).replaceAll('~', '~0').replaceAll('/', '~1')
  return `#/${path.map(escapeSegment).join('/')}`
}

function schemaNodeKey(file: string, path: SchemaPath): string {
  return `${file}${jsonPointer(path)}`
}

/** `not` children are predicates over their parent, not independently serialized wire objects. */
function isNegatedPredicate(path: SchemaPath): boolean {
  return path.some(
    (segment, index) => segment === 'not' && path[index - 1] !== 'properties' && path[index - 1] !== '$defs',
  )
}

// The ACP exemption is an explicit list constant rather than a hard-coded `/acp/` substring. The ACP
// upstream schema is vendored verbatim and this rule does not apply to it. Profile/lockfile
// seams are narrower field-level exceptions below: neither entire document is exempt.
const EXEMPT_PATH_FRAGMENTS = ['/acp/']

function isExempt(file: string): boolean {
  return EXEMPT_PATH_FRAGMENTS.some((frag) => file.split(sep).join('/').includes(frag))
}

// The intent of this rule is "no schema may silently accept unconstrained extra fields", not "no
// dictionary types". A `Record<string, T>` mapping — any key, but the values are typed — is spelled
// natively in JSON Schema as `{"type":"object","additionalProperties":{...value schema...}}` with no
// `properties`. That declares the type of every value and is not unconstrained, so it gets its own
// exception rather than being forced to `additionalProperties:false`.
// (An earlier version of this rule was worked around by rewriting `JsonValue`'s object branch and
// `Actor.attrs` as `patternProperties:{"^.*$":...}` + `additionalProperties:false`. Once the
// generator started recognising the native dictionary spelling as "no properties and
// additionalProperties is a schema → Type.Record", that workaround would be read by the generator as
// a branch that bare-rejects every key, blowing up every event's `data` and `Actor.attrs`. So the
// correct fix was to relax the guard, not to keep working around it.)
//
// `additionalProperties === true` — a genuinely open object — is let through only when registered on
// this exemption list. The one entry is `ErrorData` in `agnes-v1.json`: the extra fields on
// `error.data` vary with the error code and cannot be enumerated as `properties`.
// Key format is `${relative file path}${RFC 6901 JSON pointer}`, e.g.
// `packages/protocol/schema/agnes-v1.json#/$defs/ErrorData`. `walk()` retains path segments until
// `schemaNodeKey()` escapes them, so a property containing `.` or `/` cannot collide with a nested
// definition. `session-v1.json` has zero exemptions across the whole file, and nothing
// beyond `ErrorData` may be added.
const ADDITIONAL_PROPERTIES_TRUE_EXEMPT = new Set<string>([
  'packages/protocol/schema/agnes-v1.json#/$defs/ErrorData',
])

// MCP servers own their tool input schemas, so this one catalog DTO intentionally combines a small
// set of fields Agnes understands with schema-valued extra JSON Schema keywords that must survive
// transport unchanged. Keep the permission at one definition, and pin the locally interpreted
// fields so a later edit cannot accidentally turn this narrow compatibility seam into a generic
// mixed fixed/dictionary object.
const MCP_INPUT_SCHEMA_KEY = 'packages/protocol/schema/resource-control.json#/$defs/McpInputSchema'
function isMcpInputSchemaCompatibilitySeam(obj: Record<string, unknown>, key: string): boolean {
  if (key !== MCP_INPUT_SCHEMA_KEY) return false
  const hasOnlyKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
    Object.keys(value).sort().join(',') === [...expected].sort().join(',')
  if (!hasOnlyKeys(obj, ['type', 'required', 'properties', 'additionalProperties'])) return false
  const props = obj.properties
  if (!props || typeof props !== 'object' || Array.isArray(props)) return false
  const fields = props as Record<string, unknown>
  if (!hasOnlyKeys(fields, ['type', 'properties', 'required', 'description'])) return false

  const type = fields.type as Record<string, unknown> | undefined
  const properties = fields.properties as Record<string, unknown> | undefined
  const required = fields.required as Record<string, unknown> | undefined
  const description = fields.description as Record<string, unknown> | undefined
  const propertyValues = properties?.additionalProperties as Record<string, unknown> | undefined
  const requiredItems = required?.items as Record<string, unknown> | undefined
  const extras = obj.additionalProperties as Record<string, unknown> | undefined
  return (
    !!type &&
    hasOnlyKeys(type, ['const']) &&
    type?.const === 'object' &&
    !!properties &&
    hasOnlyKeys(properties, ['type', 'additionalProperties']) &&
    properties?.type === 'object' &&
    !!propertyValues &&
    hasOnlyKeys(propertyValues, ['$ref']) &&
    propertyValues?.$ref === 'session-v1.json#/$defs/JsonValue' &&
    !!required &&
    hasOnlyKeys(required, ['type', 'items']) &&
    required?.type === 'array' &&
    !!requiredItems &&
    hasOnlyKeys(requiredItems, ['type']) &&
    requiredItems?.type === 'string' &&
    !!description &&
    hasOnlyKeys(description, ['type', 'maxLength']) &&
    description?.type === 'string' &&
    description.maxLength === 2048 &&
    Array.isArray(obj.required) &&
    obj.required.length === 1 &&
    obj.required[0] === 'type' &&
    !!extras &&
    hasOnlyKeys(extras, ['$ref']) &&
    extras?.$ref === 'session-v1.json#/$defs/JsonValue'
  )
}

// Shared by the guard scan and the unit self-tests below: given a JSON Schema node — and the key
// locating it in the file, used only to look it up in the exemption list above — return a description
// of how it violates "objects must be closed, dictionaries excepted", or null if it does not.
// Four shapes:
//   1. Has `properties` → `additionalProperties` must be `false` (`true` only via a registered
//      exemption).
//   2. No `properties`, `additionalProperties` is a schema object → legal (a dictionary type).
//   3. No `properties`, `additionalProperties` missing or `true` → violation (a bare open object,
//      the hole this rule exists to close).
//   4. `patternProperties` is always a violation (see below; an older version endorsed it here).
function checkObjectCloses(obj: Record<string, unknown>, key: string): string | null {
  if (obj.type !== 'object') return null
  const hasProps = obj.properties !== undefined && obj.properties !== null
  const ap = obj.additionalProperties

  // ── This check used to be inverted ──────────────────────────────────────────────────────
  // The old comment here read: "a spelling that includes patternProperties is already let through by
  // the additionalProperties:false check, so no separate branch is needed" — meaning this guard
  // **explicitly endorsed `patternProperties + additionalProperties:false`**. Putting that shape into
  // session-v1.json left the guard green with 5 passed, while the generator produced
  // `Type.Object({}, { additionalProperties: false })` for the same node: **an always-false validator
  // rejecting every key**, with patternProperties silently dropped.
  // That is the exact failure mode this repo had been bitten by once before — the schema was changed
  // and the guard was relaxed, but the trap itself was never closed, so the guard became an
  // endorsement of it.
  // Both sides are now closed: the generator fail-fasts on patternProperties (the leftover-key check
  // in tools/gen-core.ts) and this guard reports it as a violation. A dictionary with any key and
  // typed values is spelled `{"type":"object","additionalProperties":{…value schema…}}` (branch 2
  // below), never with patternProperties.
  // This must be checked before `ap === false`, or the closed spelling escapes through that early
  // return again.
  if (obj.patternProperties !== undefined)
    return 'patternProperties is not allowed (the generator silently drops it; combined with additionalProperties:false it compiles to a validator that rejects every key) — use additionalProperties: {…value schema…} for dict types'

  if (ap === false) return null // closed: everything outside the keys properties names is rejected
  if (ap === true) {
    return ADDITIONAL_PROPERTIES_TRUE_EXEMPT.has(key)
      ? null
      : 'additionalProperties must be false (or a registered E42 exemption)'
  }
  if (ap !== undefined && ap !== null && typeof ap === 'object') {
    // Dictionary type Record<string, T>: additionalProperties is the value schema and declares the
    // type of every value, so it is not "unconstrained". This spelling is only reasonable when there
    // are no properties — mixing properties with the dictionary form (fixed fields plus arbitrary
    // typed extras) is unspecified, and is treated as a violation under the closed-object rule to
    // avoid an intermediate state nobody asked for.
    return hasProps && !isMcpInputSchemaCompatibilitySeam(obj, key)
      ? 'additionalProperties must be false (dict-shaped additionalProperties cannot combine with properties)'
      : null
  }
  // additionalProperties missing: a bare open object, the hole this rule exists to close
  return 'additionalProperties must be false (or a value schema for dict types)'
}

// Composition fields belong only to these three document shapes. Match the whole path so a nested
// wire object, a sibling definition, or a similarly named file cannot borrow this permission.
const SEAMS_FIELDS = new Set([
  'packages/protocol/schema/profile.json#/$defs/RuntimeProfileManifest',
  'packages/protocol/schema/profile.json#/$defs/ResolvedProfile',
  'packages/protocol/schema/lockfile.json#/$defs/Lockfile',
])
function checkSeams(obj: Record<string, unknown>, key: string): string[] {
  const errors: string[] = []
  const allowed = SEAMS_FIELDS.has(key)
  const props = obj.properties as Record<string, unknown> | undefined
  if (props && 'seams' in props && !allowed) errors.push('has seams (properties)')
  const defs = obj.$defs as Record<string, unknown> | undefined
  if (defs && 'seams' in defs) errors.push('has seams ($defs)')
  const patterns = obj.patternProperties as Record<string, unknown> | undefined
  if (patterns && 'seams' in patterns) errors.push('has seams (patternProperties)')
  if (Array.isArray(obj.required) && obj.required.includes('seams') && !allowed)
    errors.push('has seams (required)')
  return errors
}

describe('protocol schema guards', () => {
  const files = listJson(schemaDir).filter((f) => !isExempt(f))

  // vitest 5.0.0 reports "No test found in suite" for an empty describe or an empty it.each, where
  // earlier versions did not. it.runIf is used rather than a static if/else placeholder: once files is
  // non-empty, this case skips itself automatically instead of becoming a vacuously true zombie
  // assertion, while the it.each is always registered in the same describe, guaranteeing at least one
  // real case exists whenever files is non-empty.
  it.runIf(files.length === 0)('no schema files yet (packages/protocol/schema/ not created)', () => {
    expect(files).toEqual([])
  })

  it.each(files.map((f) => [relative(root, f).split(sep).join('/'), f]))(
    '%s: no `seams` property, objects close additionalProperties (dict types excepted)',
    (rel, file) => {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as unknown
      const problems: string[] = []
      walk(doc, [], (obj, p) => {
        const pointer = jsonPointer(p)
        const key = schemaNodeKey(rel, p)
        problems.push(...checkSeams(obj, key).map((message) => `${pointer}: ${message}`))

        // Closing a required-only predicate below `not` changes its meaning: the parent object's
        // ordinary fields become forbidden, so the predicate stops matching the very object it is
        // supposed to reject. The enclosing wire object remains subject to this guard.
        const msg = isNegatedPredicate(p) ? null : checkObjectCloses(obj, key)
        if (msg) problems.push(`${pointer}: ${msg}`)
      })
      expect(problems).toEqual([])
    },
  )
})

// Self-tests for the dictionary-type exception, run directly against checkObjectCloses rather than
// depending on the real files under packages/protocol/schema/ — the real-file scenario is already
// covered by the it.each above.
describe('checkObjectCloses (dictionary-type exception)', () => {
  it('distinguishes a schema not-keyword from a wire property named not', () => {
    expect(isNegatedPredicate(['$defs', 'Call', 'not', 'anyOf', 0])).toBe(true)
    expect(isNegatedPredicate(['$defs', 'Call', 'properties', 'not'])).toBe(false)
    expect(isNegatedPredicate(['$defs', 'not'])).toBe(false)
  })

  it('dict-shaped additionalProperties (no properties) passes', () => {
    const dict = { type: 'object', additionalProperties: { type: 'string' } }
    expect(checkObjectCloses(dict, 'unit-test#/dict')).toBeNull()
  })
  it('bare {"type":"object"} (no properties, no additionalProperties) is flagged', () => {
    const bare = { type: 'object' }
    expect(checkObjectCloses(bare, 'unit-test#/bare')).not.toBeNull()
  })
  it('properties present but additionalProperties missing is flagged', () => {
    const openWithProps = { type: 'object', properties: { a: { type: 'string' } } }
    expect(checkObjectCloses(openWithProps, 'unit-test#/props-open')).not.toBeNull()
  })

  // Before the fix this case was **green** — the guard endorsed the shape — while the generator
  // produced `Type.Object({}, { additionalProperties: false })` for the same node, an always-false
  // validator rejecting every key.
  it('patternProperties + additionalProperties:false is flagged (previously let through)', () => {
    const trap = {
      type: 'object',
      patternProperties: { '^.*$': { type: 'string' } },
      additionalProperties: false,
    }
    expect(checkObjectCloses(trap, 'unit-test#/pattern-props-closed')).toMatch(/patternProperties/)
  })
  it('patternProperties with a dict-shaped additionalProperties is also flagged', () => {
    const trap = {
      type: 'object',
      patternProperties: { '^x-': { type: 'string' } },
      additionalProperties: { type: 'string' },
    }
    expect(checkObjectCloses(trap, 'unit-test#/pattern-props-dict')).toMatch(/patternProperties/)
  })
})

describe('McpInputSchema compatibility exception stays exact', () => {
  const mcpInputSchema = {
    type: 'object',
    required: ['type'],
    properties: {
      type: { const: 'object' },
      properties: {
        type: 'object',
        additionalProperties: { $ref: 'session-v1.json#/$defs/JsonValue' },
      },
      required: { type: 'array', items: { type: 'string' } },
      description: { type: 'string', maxLength: 2048 },
    },
    additionalProperties: { $ref: 'session-v1.json#/$defs/JsonValue' },
  }

  it('allows only the intended file and definition with its fixed constraints intact', () => {
    expect(checkObjectCloses(mcpInputSchema, MCP_INPUT_SCHEMA_KEY)).toBeNull()
  })

  it('rejects sibling, nested and similarly named definitions with the same mixed shape', () => {
    for (const key of [
      'packages/protocol/schema/resource-control.json#/$defs/McpTool',
      `${MCP_INPUT_SCHEMA_KEY}/properties/nested`,
      `${MCP_INPUT_SCHEMA_KEY}Copy`,
      MCP_INPUT_SCHEMA_KEY.replace('resource-control.json', 'resource-control-copy.json'),
    ])
      expect(checkObjectCloses(mcpInputSchema, key)).toMatch(/dict-shaped/)
  })

  it('does not let a dotted top-level property collide with the nested definition path', () => {
    const outcomes: Array<{ key: string; result: string | null }> = []
    walk(
      {
        $defs: { McpInputSchema: mcpInputSchema },
        '$defs.McpInputSchema': structuredClone(mcpInputSchema),
      },
      [],
      (node, path) => {
        if (
          node.type !== 'object' ||
          node.properties === undefined ||
          node.additionalProperties === undefined
        )
          return
        const key = schemaNodeKey('packages/protocol/schema/resource-control.json', path)
        outcomes.push({ key, result: checkObjectCloses(node, key) })
      },
    )
    expect(outcomes).toEqual([
      { key: MCP_INPUT_SCHEMA_KEY, result: null },
      {
        key: 'packages/protocol/schema/resource-control.json#/$defs.McpInputSchema',
        result:
          'additionalProperties must be false (dict-shaped additionalProperties cannot combine with properties)',
      },
    ])
  })

  it('rejects the exact path when a locally interpreted field is weakened', () => {
    for (const schema of [
      { ...mcpInputSchema, required: [] },
      {
        ...mcpInputSchema,
        properties: { ...mcpInputSchema.properties, type: { const: 'array' } },
      },
      {
        ...mcpInputSchema,
        properties: {
          ...mcpInputSchema.properties,
          description: { type: 'string', maxLength: 4096 },
        },
      },
      {
        ...mcpInputSchema,
        properties: {
          ...mcpInputSchema.properties,
          required: { type: 'array', items: { type: 'string' }, maxItems: 1 },
        },
      },
      { ...mcpInputSchema, additionalProperties: { type: 'string' } },
      {
        ...mcpInputSchema,
        additionalProperties: { $ref: 'session-v1.json#/$defs/JsonValue', extra: true },
      },
    ])
      expect(checkObjectCloses(schema, MCP_INPUT_SCHEMA_KEY)).toMatch(/dict-shaped/)
  })
})

describe('composition seams exceptions stay exact', () => {
  const field = { properties: { seams: {} }, required: ['seams'] }
  it('allows only the three composition fields, retaining closed-object enforcement', () => {
    for (const key of SEAMS_FIELDS) {
      expect(checkSeams(field, key)).toEqual([])
      expect(checkObjectCloses({ type: 'object', ...field }, key)).not.toBeNull()
      expect(checkSeams({ $defs: { seams: {} } }, key)).toEqual(['has seams ($defs)'])
      expect(checkSeams({ patternProperties: { seams: {} } }, key)).toEqual(['has seams (patternProperties)'])
    }
  })
  it('rejects nearby paths, filenames and wire definitions', () => {
    for (const key of SEAMS_FIELDS)
      for (const probe of [
        `${key}.properties.nested`,
        `${key}Extra`,
        key.replace('schema/', 'schema/nested/'),
        key.replace('.json', '-copy.json'),
      ]) {
        expect(checkSeams(field, probe)).toEqual(['has seams (properties)', 'has seams (required)'])
      }
    expect(checkSeams(field, 'packages/protocol/schema/agnes-v1.json#/$defs/SomeParams')).toHaveLength(2)
  })
})
