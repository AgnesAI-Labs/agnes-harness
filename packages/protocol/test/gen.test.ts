import { readFileSync } from 'node:fs'
import { Value } from '@sinclair/typebox/value'
import { describe, expect, it } from 'vitest'
import { generateModule, UNSUPPORTED_NODES } from '../tools/gen-core.js'

const mini = {
  $defs: {
    Name: { type: 'string', minLength: 1, maxLength: 8 },
    Point: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y'],
      properties: { x: { type: 'integer' }, y: { type: 'integer' }, tag: { $ref: '#/$defs/Name' } },
    },
    Shape: {
      oneOf: [
        { const: 'circle' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: { kind: { const: 'poly' }, pts: { type: 'array', items: { $ref: '#/$defs/Point' } } },
        },
      ],
    },
    Nullable: { type: ['string', 'null'] },
    Any: { anyOf: [{ type: 'null' }, { type: 'array', items: { $ref: '#/$defs/Any' } }] },
  },
}

describe('generateModule', () => {
  it('emits a Type.Module with one Import per $def', () => {
    const src = generateModule(mini, 'Mini')
    expect(src).toContain("import { Type, type Static } from '@sinclair/typebox'")
    expect(src).toContain('export const Mini = Type.Module({')
    expect(src).toContain("export const Point = Mini.Import('Point')")
    expect(src).toContain('export type Point = Static<typeof Point>')
    expect(src).toContain("Type.Ref('Name')")
    expect(src).toContain('additionalProperties: false')
    expect(src).toContain("Type.Literal('circle')")
    expect(src).toContain('Type.Union([Type.String(), Type.Null()])')
  })
  it('generated session-v1 module validates a minimal envelope', async () => {
    const mod = await import('../gen/ts/session-v1.js')
    const ok = Value.Check(mod.EventEnvelope, {
      seq: 1,
      ts: '2026-09-07T00:00:00Z',
      id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'hi' }] },
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      origin: 'principal',
      trust: 'trusted',
    })
    expect(ok).toBe(true)
    expect(Value.Check(mod.EventEnvelope, { seq: 1 })).toBe(false)
  })
  it('checked-in gen/ts/session-v1.ts equals a fresh generation', () => {
    const schema = JSON.parse(readFileSync(new URL('../schema/session-v1.json', import.meta.url), 'utf8'))
    const fresh = generateModule(schema, 'SessionV1')
    const onDisk = readFileSync(new URL('../gen/ts/session-v1.ts', import.meta.url), 'utf8')
    expect(onDisk).toBe(fresh)
  })
})

// Every JSON Schema keyword the generator learns to handle gets a case here. The two below cover the
// two known risks hit so far: a self-referencing $def (the Type.Recursive path) and the handling
// strategy for the 'format' keyword.
describe('generateModule: self-referencing $def (recursion)', () => {
  it('emits a self-referencing def as a standalone Type.Recursive const, not inside Type.Module', () => {
    const src = generateModule(mini, 'Mini')
    // "Any" refers to itself directly (items points back at #/$defs/Any), so it must be lifted out of
    // Type.Module({...}), use This for the internal self-loop, and appear before the Module
    // declaration (JS evaluation order).
    expect(src).toContain(
      'export const Any = Type.Recursive((This) => Type.Union([Type.Null(), Type.Array(This)]))',
    )
    expect(src).toContain('export type Any = Static<typeof Any>')
    expect(src.indexOf('export const Any = Type.Recursive')).toBeLessThan(
      src.indexOf('export const Mini = Type.Module({'),
    )
    // Once lifted out, "Any" is no longer a Mini.Import target — it is not in Type.Module({...})'s
    // defs table
    expect(src).not.toContain("Mini.Import('Any')")
  })

  it('the real session-v1 JsonValue module validates deeply nested values both directions (array + dict)', async () => {
    const mod = await import('../gen/ts/session-v1.js')
    expect(Value.Check(mod.JsonValue, { a: [1, { b: [null, 'x', { c: 2 }] }] })).toBe(true)
    expect(Value.Check(mod.JsonValue, undefined)).toBe(false)
    // Reaching JsonValue indirectly through another def (ToolCall.args) must also validate the
    // recursive structure correctly, proving that inlining a bare identifier at a property position
    // inside Type.Module works at runtime too.
    expect(
      Value.Check(mod.ToolCall, {
        toolUseId: 't1',
        name: 'run',
        args: { nested: [1, 2, { deep: { x: null } }] },
        ordinal: 0,
      }),
    ).toBe(true)
  })
})

// Recursion handling was previously only verified for direct self-reference (one $def pointing back
// at itself). Indirect cycles (A → B → A, two different $defs referring to each other) were never
// tested specifically, and agnes-v1.json could introduce that shape. Conclusion: the existing
// mechanism supports it natively, no extra handling needed. The evidence has two parts:
//   1. Runtime: below, a real fixture (not an inline assembled string) verifies Value.Check validates
//      recursively back and forth between Node and Edge.
//   2. Type level: test/fixtures/gen/mutual-recursion.ts is a real .ts file produced by running
//      generateModule over the schema in the same directory and checked in verbatim. It lives in a
//      directory named gen so it picks up biome.json's `"!**/gen"` exclusion and, like
//      packages/protocol/gen/ts, is never rewritten by the formatter — otherwise it would fight the
//      "checked-in file equals a fresh generation" case below. protocol's tsconfig.json `include` is
//      `**/*.ts`, so `pnpm typecheck` (`tsc -b`) already compiles this fixture; no tsc subprocess
//      needs to be spawned in this case, since the full typecheck covers "it compiles" in passing.
describe('generateModule: indirect (mutual) recursion — A → B → A (Node ↔ Edge)', () => {
  it('does NOT wrap Node/Edge in Type.Recursive — plain Type.Ref both ways is sufficient', () => {
    const schema = JSON.parse(
      readFileSync(new URL('./fixtures/mutual-recursion.schema.json', import.meta.url), 'utf8'),
    )
    const src = generateModule(schema, 'MutualRecursion')
    expect(src).not.toContain('Type.Recursive')
    expect(src).toContain("Type.Ref('Edge')")
    expect(src).toContain("Type.Ref('Node')")
  })

  it('checked-in fixtures/gen/mutual-recursion.ts equals a fresh generation (kept in sync, and is what tsc -b type-checks)', () => {
    const schema = JSON.parse(
      readFileSync(new URL('./fixtures/mutual-recursion.schema.json', import.meta.url), 'utf8'),
    )
    const fresh = generateModule(schema, 'MutualRecursion')
    const onDisk = readFileSync(new URL('./fixtures/gen/mutual-recursion.ts', import.meta.url), 'utf8')
    expect(onDisk).toBe(fresh)
  })

  it('validates a nested Node ↔ Edge cycle at runtime, both the happy path and a broken one', async () => {
    const mod = await import('./fixtures/gen/mutual-recursion.js')
    const sample = { id: 'a', edges: [{ to: { id: 'b', edges: [{ to: { id: 'c', edges: [] } }] } }] }
    expect(Value.Check(mod.Node, sample)).toBe(true)
    expect(Value.Check(mod.Node, { id: 'a' })).toBe(false) // missing edges
    expect(Value.Check(mod.Edge, { to: { id: 'a', edges: [] } })).toBe(true)
    expect(Value.Check(mod.Edge, { to: { id: 'a' } })).toBe(false) // the nested Node is missing edges
  })
})

// A format must really be registered as a check and never dropped: the draft version, which dropped
// format, left fields declaring `"format": "date-time"` (as EventEnvelope.ts does) unable to ever
// fail — worse than not declaring it at all.
// So format stays in Type.String's options, and generateModule emits FormatRegistry registration code
// at the head of the generated module for every format in use. That code goes into gen/ts/*.ts rather
// than src/, because the package exports "./gen/*" and a consumer importing the generated module on
// its own needs the registration to travel with it.
describe('generateModule: JSON Schema "format" keyword (registers a checker, keeps the constraint)', () => {
  const withFormat = { $defs: { Stamp: { type: 'string', format: 'date-time', maxLength: 64 } } }
  const noFormat = { $defs: { Plain: { type: 'string', maxLength: 8 } } }
  const twoFieldsSameFormat = {
    $defs: {
      Envelope: {
        type: 'object',
        additionalProperties: false,
        required: ['createdAt', 'updatedAt'],
        properties: {
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  }

  it('keeps format in the emitted Type.String options', () => {
    const src = generateModule(withFormat, 'WithFormat')
    expect(src).toContain('Type.String({ maxLength: 64, format: "date-time" })')
  })

  it('emits a FormatRegistry registration for the format actually used', () => {
    const src = generateModule(withFormat, 'WithFormat')
    expect(src).toContain("import { FormatRegistry } from '@sinclair/typebox'")
    expect(src).toContain("if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time',")
  })

  it('does not emit FormatRegistry import or registration when no $def uses format', () => {
    const src = generateModule(noFormat, 'NoFormat')
    expect(src).not.toContain('FormatRegistry')
  })

  it('registers a format used by multiple fields only once', () => {
    const src = generateModule(twoFieldsSameFormat, 'TwoFieldsSameFormat')
    const occurrences = src.split("FormatRegistry.Set('date-time'").length - 1
    expect(occurrences).toBe(1)
  })

  it('throws generation-time if a format has no registered checker (fail fast, not a silently unenforced field)', () => {
    const unknownFormat = { $defs: { X: { type: 'string', format: 'not-a-real-format' } } }
    expect(() => generateModule(unknownFormat, 'X')).toThrow(/no FORMAT_CHECKERS entry for format/)
  })

  it('the registered date-time checker actually validates through the real generated module (EventEnvelope.ts)', async () => {
    // Use the real generated module (session-v1's EventEnvelope.ts is exactly format: 'date-time')
    // rather than re-assembling the checker function string, so this directly proves the registration
    // code in gen/ts/session-v1.ts takes effect at runtime.
    const mod = await import('../gen/ts/session-v1.js')
    const envelope = (ts: unknown) => ({
      seq: 1,
      ts,
      id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'hi' }] },
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      origin: 'principal',
      trust: 'trusted',
    })
    expect(Value.Check(mod.EventEnvelope, envelope('2026-09-08T00:00:00Z'))).toBe(true)
    expect(Value.Check(mod.EventEnvelope, envelope('not-a-date'))).toBe(false)
    expect(Value.Check(mod.EventEnvelope, envelope(''))).toBe(false)
  })
})

// The string + anyOf branch once dropped the outer sibling constraints (here maxLength) entirely and
// looked only at the anyOf branches themselves. For EventEnvelope.type (enum ∪ pattern with an outer
// maxLength:128) that meant a 208-character extension event type string matching the pattern branch
// was judged VALID, where real ajv judged it INVALID — caught by differential testing against ajv.
// The fix: merge the outer constraints (excluding anyOf itself) into each branch before emitting,
// since (outer ∧ b1) ∨ (outer ∧ b2) ∨ ... is equivalent to outer ∧ (b1 ∨ b2 ∨ ...).
// Reproduced and pinned with a standalone fixture rather than an inline assembled string: the pattern
// itself is covered by test/fixtures/sibling-constraints.schema.json (smaller and more focused than
// EventEnvelope.type), while the real regression case runs end to end in validate.test.ts against the
// 208-character EventEnvelope.type instance.
describe('generateModule: sibling constraints alongside string anyOf (outer must apply to every branch)', () => {
  it('merges outer maxLength into the pattern branch instead of dropping it', () => {
    const schema = JSON.parse(
      readFileSync(new URL('./fixtures/sibling-constraints.schema.json', import.meta.url), 'utf8'),
    )
    const src = generateModule(schema, 'SiblingConstraints')
    expect(src).toContain('Type.String({ maxLength: 10, pattern: "^ok-.*$" })')
    // The enum branch: outer's maxLength deliberately does not show up here, because the branch is
    // already a concrete literal of fixed length. See the corresponding comment in emit() in
    // tools/gen-core.ts — this is not an oversight.
    expect(src).toContain("Type.Literal('fixed')")
  })

  it('checked-in fixtures/gen/sibling-constraints.ts equals a fresh generation', () => {
    const schema = JSON.parse(
      readFileSync(new URL('./fixtures/sibling-constraints.schema.json', import.meta.url), 'utf8'),
    )
    const fresh = generateModule(schema, 'SiblingConstraints')
    const onDisk = readFileSync(new URL('./fixtures/gen/sibling-constraints.ts', import.meta.url), 'utf8')
    expect(onDisk).toBe(fresh)
  })

  it('a value that matches the pattern branch but is too long is INVALID (the ajv-caught bug, minimal repro)', async () => {
    const mod = await import('./fixtures/gen/sibling-constraints.js')
    expect(Value.Check(mod.ExtLikeType, 'ok-x')).toBe(true) // matches pattern, within maxLength:10
    expect(Value.Check(mod.ExtLikeType, `ok-${'a'.repeat(20)}`)).toBe(false) // matches pattern, over maxLength:10
    expect(Value.Check(mod.ExtLikeType, 'fixed')).toBe(true) // enum branch
    expect(Value.Check(mod.ExtLikeType, 'not-matching-anything')).toBe(false)
  })
})

// The string+anyOf fix closed one hole; the same class of "outer sibling constraint silently dropped
// by a combinator branch" remained on emit()'s other paths — `oneOf`/`allOf` with siblings, a
// top-level type-less `anyOf` with siblings, and `anyOf` sitting beside a `type` that is not 'string'
// (e.g. `{type:'array', anyOf:[...]}`, where the switch's 'array' branch never looks at anyOf).
// Those were handled by fail-fast at the time: there was no real-world case to validate the
// Union/Intersect expansion against, and implementing it was not cheap.
//
// Then the real-world case arrived: the upstream ACP schema uses the discriminated-union shape (an
// outer object shell of `type`+`properties`+`required` stacked on `oneOf`/`anyOf`/`allOf`, each branch
// stacking a further `allOf:[{$ref}]` pointing at the concrete variant's fields) all over the place —
// `ContentBlock`, `SessionUpdate`, `SessionConfigOption`, `AuthMethod`, `McpServer` and a dozen more.
// Not a corner case, so it had to be genuinely supported rather than degraded to Unknown().
// `emitCombinator` (tools/gen-core.ts) now folds such siblings into a Type.Intersect per branch and
// then Unions/Intersects those. Fail-fast remains only where a sibling or a branch has no
// type/$ref/const/enum/nested combinator of its own and emit() would degrade to `Type.Unknown()` —
// folding that into an Intersect means AND-ing with something always true, which really does drop the
// constraint silently.
// The four fail-fast cases below were therefore rewritten from "we do not handle this combination at
// all" to "we still intercept this specific degenerate case", and the first assertion changed with
// them: it no longer checks a vague "unrecognised type" but which branch or side degenerated.
describe('generateModule: fail-fast on combinator + sibling shapes emit() cannot consume', () => {
  it('throws for `{type:"array", items, anyOf}` — the branches have no type of their own to merge', () => {
    const schema = {
      $defs: {
        Weird: {
          type: 'array',
          items: { type: 'string' },
          anyOf: [{ minItems: 1 }, { maxItems: 3 }],
        },
      },
    }
    // The outer {type:'array', items} emits fine on its own and is not what triggers the failure; the
    // branches {minItems:1}/{maxItems:3} having no type of their own are. This fail-fast is now
    // carried by emit()'s leftover-key check, whose message is more precise (a pointer as deep as
    // /anyOf/0, and the advice "give this node a type"). The old "branch 0 resolves to
    // Type.Unknown()" check inside emitCombinator became unreachable and was removed.
    expect(() => generateModule(schema, 'Weird')).toThrow(/\/\$defs\/Weird\/anyOf\/0/)
    expect(() => generateModule(schema, 'Weird')).toThrow(/minItems/)
    expect(() => generateModule(schema, 'Weird')).toThrow(/declares no 'type'/)
  })

  it('throws for a top-level (untyped) `{anyOf, maxLength}` — sibling keys beside anyOf with no type', () => {
    const schema = {
      $defs: {
        Weird: { anyOf: [{ type: 'string' }, { type: 'number' }], maxLength: 10 },
      },
    }
    // As above: the trigger is outerRest `{maxLength:10}`, which has no type of its own once the
    // combinator key is removed.
    expect(() => generateModule(schema, 'Weird')).toThrow(/\/\$defs\/Weird/)
    expect(() => generateModule(schema, 'Weird')).toThrow(/maxLength/)
    expect(() => generateModule(schema, 'Weird')).toThrow(/declares no 'type'/)
  })

  it('throws for `oneOf` combined with sibling keys (e.g. type + properties riding along oneOf)', () => {
    const schema = {
      $defs: {
        Weird: {
          type: 'object',
          properties: { kind: { type: 'string' } },
          oneOf: [{ required: ['kind'] }],
        },
      },
    }
    // The branch {required:['kind']} has no type of its own; the leftover-key check now throws on
    // /oneOf/0.
    expect(() => generateModule(schema, 'Weird')).toThrow(/\/\$defs\/Weird\/oneOf\/0/)
    expect(() => generateModule(schema, 'Weird')).toThrow(/required/)
  })

  it('throws for `allOf` combined with sibling keys', () => {
    const schema = {
      $defs: { Weird: { type: 'string', allOf: [{ minLength: 1 }] } },
    }
    expect(() => generateModule(schema, 'Weird')).toThrow(/allOf/)
  })

  // Boundary pinning: shapes that are already supported must not be caught by these checks.
  // string+anyOf with outer constraints, and bare anyOf/oneOf with no siblings, must all keep
  // generating normally rather than throwing.
  it('does NOT throw for the already-supported string+anyOf+outer-constraint shape', () => {
    const schema = {
      $defs: {
        ExtLikeType: { type: 'string', maxLength: 10, anyOf: [{ enum: ['fixed'] }, { pattern: '^ok-.*$' }] },
      },
    }
    expect(() => generateModule(schema, 'ExtLikeType')).not.toThrow()
  })

  it('does NOT throw for pure anyOf/oneOf with no sibling keys', () => {
    const pureAnyOf = { $defs: { X: { anyOf: [{ type: 'string' }, { type: 'null' }] } } }
    const pureOneOf = { $defs: { X: { oneOf: [{ const: 'a' }, { const: 'b' }] } } }
    expect(() => generateModule(pureAnyOf, 'X')).not.toThrow()
    expect(() => generateModule(pureOneOf, 'X')).not.toThrow()
  })
})

// emitCombinator's general merging against a realistic shape: the ACP discriminated union (an outer
// object shell of type/properties/required stacked on oneOf/anyOf/allOf, each branch stacking a
// further allOf:[{$ref}]). A fixture smaller than ACP but structurally identical pins both the shape
// of the generated module and its runtime behaviour, without depending on the real gen/ts/acp.ts —
// that is pinned separately in its own section below, giving double coverage: the small fixture proves
// the mechanism, the real file proves no other branch is accidentally triggered on genuine ACP input.
// The fixture follows the same pattern as mutual-recursion / sibling-constraints: the schema is stored
// as its own .schema.json and the generated module is checked in verbatim under test/fixtures/gen/
// (a directory biome.json's "!**/gen" excludes, so the formatter never rewrites it), with the full
// typecheck covering its type level in passing.
describe('generateModule: oneOf/allOf sibling merge (the ACP discriminated-union shape)', () => {
  it('checked-in fixtures/gen/shape-merge.ts equals a fresh generation', () => {
    const schema = JSON.parse(
      readFileSync(new URL('./fixtures/shape-merge.schema.json', import.meta.url), 'utf8'),
    )
    const fresh = generateModule(schema, 'ShapeMerge')
    const onDisk = readFileSync(new URL('./fixtures/gen/shape-merge.ts', import.meta.url), 'utf8')
    expect(onDisk).toBe(fresh)
  })

  it('folds the outer object shell into each oneOf branch via Type.Intersect, ignoring description/discriminator', () => {
    const schema = JSON.parse(
      readFileSync(new URL('./fixtures/shape-merge.schema.json', import.meta.url), 'utf8'),
    )
    const src = generateModule(schema, 'ShapeMerge')
    expect(src).toContain('Type.Union([Type.Intersect([')
    // The "circle" branch is itself an allOf with siblings (type/properties/required stacked on
    // allOf:[{$ref}]), so it recurses through the same merging path and folds into a single Intersect
    // rather than two nested ones:
    expect(src).toContain(
      "Type.Intersect([Type.Object({ \"kind\": Type.Literal('circle') }), Type.Ref('Extra')])",
    )
    // Annotation keys never appear in the generated module at all — they only affect emit()'s
    // internal decision about whether to merge, and are not validation constraints
    expect(src).not.toContain('circle branch')
    expect(src).not.toContain('propertyName')
  })

  it('validates real values end-to-end: the outer shell + exactly one branch, both directions', async () => {
    const mod = await import('./fixtures/gen/shape-merge.js')
    expect(Value.Check(mod.Shape, { id: 'a', kind: 'circle', n: 1 })).toBe(true)
    expect(Value.Check(mod.Shape, { id: 'a', kind: 'circle' })).toBe(false) // missing Extra's n (both sides of the Intersect must hold)
    expect(Value.Check(mod.Shape, { id: 'a', kind: 'square' })).toBe(true) // the second branch has no allOf, only its own kind
    expect(Value.Check(mod.Shape, { kind: 'circle', n: 1 })).toBe(false) // missing the outer shell's id
  })
})

// When `emitCombinator` assembles a `Type.Intersect`, an operand declaring
// `additionalProperties:false` — either the raw JSON node itself, or, when it is a pure `$ref`, the
// $def it points at — makes TypeBox (like plain ajv) evaluate additionalProperties independently per
// operand, so the merged type is always false for any real payload. Nothing is reported; every
// legitimate payload just fails validation, which is more insidious than an exception. This has to
// fail fast rather than be merely noted the way "degrades to Type.Unknown()" was: ACP cannot trigger
// it today (zero occurrences of additionalProperties:false in the whole file), but agnes-v1.json is
// our own schema, where a discriminated-union branch referencing a closed object is near-certain.
describe('generateModule: fail-fast when a Type.Intersect operand is a closed object (additionalProperties:false)', () => {
  it('① throws when an allOf branch is directly a closed object', () => {
    const schema = {
      $defs: {
        Weird: {
          type: 'object',
          properties: { kind: { const: 'a' } },
          required: ['kind'],
          allOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: { n: { type: 'integer' } },
              required: ['n'],
            },
          ],
        },
      },
    }
    expect(() => generateModule(schema, 'Weird')).toThrow(/\/\$defs\/Weird\/allOf\/0/)
    expect(() => generateModule(schema, 'Weird')).toThrow(/additionalProperties:false directly/)
  })

  it('② throws when an allOf branch is a bare $ref to a closed $def', () => {
    const schema = {
      $defs: {
        Closed: {
          type: 'object',
          additionalProperties: false,
          properties: { n: { type: 'integer' } },
          required: ['n'],
        },
        Weird: {
          type: 'object',
          properties: { kind: { const: 'a' } },
          required: ['kind'],
          allOf: [{ $ref: '#/$defs/Closed' }],
        },
      },
    }
    expect(() => generateModule(schema, 'Weird')).toThrow(/\/\$defs\/Weird\/allOf\/0/)
    expect(() => generateModule(schema, 'Weird')).toThrow(/bare \$ref to 'Closed'/)
    expect(() => generateModule(schema, 'Weird')).toThrow(/#\/\$defs\/Closed/)
  })

  it('③ does NOT throw when every operand is an open object — confirms `pnpm gen` output for acp.ts/session-v1.ts is untouched', () => {
    // Re-check against the real shape-merge fixture (Extra is an open object with no
    // additionalProperties:false) to confirm nothing legitimate is caught. The actual evidence that
    // the generated bytes are unchanged is the checked-in tests for test/fixtures/gen/shape-merge.ts
    // and, above, acp.ts / session-v1.ts ("checked-in ... equals a fresh generation"); this case only
    // adds one direct, focused assertion.
    const schema = JSON.parse(
      readFileSync(new URL('./fixtures/shape-merge.schema.json', import.meta.url), 'utf8'),
    )
    expect(() => generateModule(schema, 'ShapeMerge')).not.toThrow()

    // Also run a full generation over the real ACP schema. Its discriminated-union branches are all
    // open objects or $refs to open objects (grep confirms zero occurrences of
    // additionalProperties:false in acp/schema.json), so the new check must neither fail-fast on it
    // nor change its bytes — cross-checking with the checked-in acp.ts test.
    const acpSchema = JSON.parse(readFileSync(new URL('../schema/acp/schema.json', import.meta.url), 'utf8'))
    expect(() => generateModule(acpSchema, 'Acp', 'packages/protocol/schema/acp/schema.json')).not.toThrow()
  })
})

// End-to-end regression on the real generated ACP module: confirms the discriminated-union merging
// works as expected on genuine, more complex input for the 16 ACP definitions this package actually
// references (listed in schema/acp/UPSTREAM.md), not just the small fixture above. It also pins the
// UNSUPPORTED_NODES short-circuit: the 4 elicitation $defs are Type.Unknown(), meaning no structural
// validation is done for them and any value — including undefined — passes.
describe('generateModule: real ACP output (gen/ts/acp.ts) — discriminated unions + UNSUPPORTED_NODES', () => {
  it('ContentBlock validates a real text block and rejects a bad discriminant', async () => {
    const mod = await import('../gen/ts/acp.js')
    expect(Value.Check(mod.ContentBlock, { type: 'text', text: 'hi' })).toBe(true)
    expect(Value.Check(mod.ContentBlock, { type: 'text' })).toBe(false) // TextContent is missing text
    expect(Value.Check(mod.ContentBlock, { type: 'not-a-real-kind' })).toBe(false)
  })

  it('SessionConfigOption validates the outer shell AND the discriminated branch together', async () => {
    const mod = await import('../gen/ts/acp.js')
    expect(
      Value.Check(mod.SessionConfigOption, {
        id: 'opt1',
        name: 'Option 1',
        type: 'boolean',
        currentValue: true,
      }),
    ).toBe(true)
    // missing the outer shell's required name
    expect(Value.Check(mod.SessionConfigOption, { id: 'opt1', type: 'boolean', currentValue: true })).toBe(
      false,
    )
  })

  it('UNSUPPORTED_NODES: elicitation $defs are Type.Unknown() — no structural check at all', async () => {
    const mod = await import('../gen/ts/acp.js')
    expect(Value.Check(mod.CreateElicitationRequest, undefined)).toBe(true)
    expect(Value.Check(mod.CreateElicitationRequest, { anything: 'goes' })).toBe(true)
    expect(Value.Check(mod.MultiSelectItems, 42)).toBe(true)
  })

  it('checked-in gen/ts/acp.ts equals a fresh generation', () => {
    const schema = JSON.parse(readFileSync(new URL('../schema/acp/schema.json', import.meta.url), 'utf8'))
    const fresh = generateModule(schema, 'Acp', 'packages/protocol/schema/acp/schema.json')
    const onDisk = readFileSync(new URL('../gen/ts/acp.ts', import.meta.url), 'utf8')
    expect(onDisk).toBe(fresh)
  })
})

// The annotation-key filter itself: description/title/default/$comment/examples/deprecated/
// discriminator and any x-* key sitting beside a oneOf/anyOf/allOf must be treated as "no siblings",
// triggering neither merging nor fail-fast. This matches the ACP schema, where ContentBlock,
// SessionUpdate and friends carry a oneOf with only these annotation keys alongside.
describe('generateModule: annotation-only sibling keys never trigger a merge or a throw', () => {
  it('oneOf with only description/discriminator/x-* siblings stays a plain Type.Union (no Type.Intersect)', () => {
    const schema = {
      $defs: {
        Plain: {
          description: 'd',
          title: 't',
          discriminator: { propertyName: 'k' },
          'x-custom-hint': true,
          oneOf: [{ const: 'a' }, { const: 'b' }],
        },
      },
    }
    const src = generateModule(schema, 'Plain')
    expect(src).toContain("Type.Union([Type.Literal('a'), Type.Literal('b')])")
    expect(src).not.toContain('Type.Intersect')
  })
})

// The format values ACP uses fall into two groups. 'uri' hangs on type:'string', is a real string
// constraint, and has a real checker registered for it modelled on ajv-formats' behaviour. The others
// — int32/int64/uint16/uint32/uint64/double/float — all hang on type:'integer'/'number', where
// emit()'s integer/number branches never read format, so registering them would be dead weight.
// Checked against real ajv-formats, that group carries no verifiable general semantics anyway:
// uint16/32/64 are not in ajv-formats' format table at all, double/float are implemented as a literal
// `() => true`, int64 is fully redundant with type:'integer' itself, and int32 — the only one with
// extra semantics — is not reachable from the 10 methods this package references.
// So collectFormats requires a FORMAT_CHECKERS entry only for nodes that could be strings; format
// values in a numeric context need no registration and do not fail-fast.
describe('generateModule: format handling for ACP — "uri" (real checker) vs numeric formats (annotation-only)', () => {
  it('does NOT require a FORMAT_CHECKERS entry for int32/int64/uint16/uint32/uint64/double/float on integer/number fields', () => {
    const schema = {
      $defs: {
        Numbers: {
          type: 'object',
          additionalProperties: false,
          properties: {
            a: { type: 'integer', format: 'int32' },
            b: { type: 'integer', format: 'int64' },
            c: { type: ['integer', 'null'], format: 'uint16' },
            d: { type: ['integer', 'null'], format: 'uint32' },
            e: { type: 'integer', format: 'uint64' },
            f: { type: ['number', 'null'], format: 'double' },
            g: { type: 'number', format: 'float' },
          },
        },
      },
    }
    expect(() => generateModule(schema, 'Numbers')).not.toThrow()
    const src = generateModule(schema, 'Numbers')
    expect(src).not.toContain('FormatRegistry')
  })

  it('registers a real checker for "uri" and it actually enforces the constraint', async () => {
    const schema = { $defs: { Url: { type: 'string', format: 'uri' } } }
    const src = generateModule(schema, 'Url')
    expect(src).toContain("if (!FormatRegistry.Has('uri')) FormatRegistry.Set('uri',")
    const mod = await import('../gen/ts/acp.js') // the real generated module: ElicitationUrlMode.url uses this format
    // ElicitationUrlMode is outside the reachable defs, but it is still generated as a standalone
    // $def and can be validated directly. It is itself a sibling merge — an outer elicitationId/url
    // stacked on anyOf(Session or Request scope) — so one of those branches must also be satisfied;
    // here sessionId takes the ElicitationSessionScope branch.
    expect(
      Value.Check(mod.ElicitationUrlMode, {
        elicitationId: 'e1',
        url: 'https://example.com',
        sessionId: 's1',
      }),
    ).toBe(true)
    expect(
      Value.Check(mod.ElicitationUrlMode, { elicitationId: 'e1', url: 'not-a-uri', sessionId: 's1' }),
    ).toBe(false)
  })
})

// ── emit()'s leftover-key fail-fast ─────────────────────────────────────────────────────────
// Each row below was tried against generateModule() directly, and before the fix the entire table
// **returned OK with not one throw**. The first row is the worst of them:
// `{type:'object', patternProperties:…, additionalProperties:false}` was generated as
// `Type.Object({}, { additionalProperties: false })`, an **always-false validator** rejecting every
// key — and tools/guards/src/schema.test.ts explicitly endorsed that shape at the time.
// it.each pins the whole table at once: if any row is ever silently dropped again, this goes red.
const SILENTLY_DROPPED_BEFORE_S1: Array<[string, Record<string, unknown>, RegExp]> = [
  [
    'patternProperties + additionalProperties:false (always-false validator)',
    { type: 'object', patternProperties: { '^.*$': { type: 'string' } }, additionalProperties: false },
    /patternProperties/,
  ],
  [
    'minProperties',
    { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false, minProperties: 2 },
    /minProperties/,
  ],
  ['multipleOf', { type: 'integer', minimum: 1, multipleOf: 3 }, /multipleOf/],
  ['exclusiveMinimum', { type: 'number', exclusiveMinimum: 0 }, /exclusiveMinimum/],
  [
    'prefixItems',
    { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'string' } },
    /prefixItems/,
  ],
  [
    'propertyNames',
    { type: 'object', additionalProperties: { type: 'string' }, propertyNames: { maxLength: 3 } },
    /propertyNames/,
  ],
  [
    'if/then',
    {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
      if: { required: ['a'] },
      // biome-ignore lint/suspicious/noThenProperty: `then` is JSON Schema 2020-12's conditional keyword (if/then/else), not a thenable — this is a schema literal
      then: { required: ['a'] },
    },
    /if, then/,
  ],
  [
    'dependentRequired',
    {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
      dependentRequired: { a: ['b'] },
    },
    /dependentRequired/,
  ],
  [
    'unevaluatedProperties',
    {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
      unevaluatedProperties: false,
    },
    /unevaluatedProperties/,
  ],
  // The one class only an allowlist can catch, never a denylist: a name nobody ever listed.
  ["typo'd keyword maxLenght", { type: 'string', maxLenght: 5 }, /maxLenght/],
  // In JSON Schema 2020-12 a `$ref`'s siblings are an implicit AND, and emit() returning on sight of
  // a $ref would drop them.
  ['$ref with a real constraint as a sibling', { $ref: '#/$defs/Other', maxLength: 5 }, /maxLength/],
]

describe('generateModule: fail-fast on any keyword emit() does not consume', () => {
  it.each(SILENTLY_DROPPED_BEFORE_S1)('throws for %s', (_name, node, re) => {
    const schema = { $defs: { X: node, Other: { type: 'string' } } }
    expect(() => generateModule(schema, 'M', 'probe.json')).toThrow(re)
    // The message must carry a JSON pointer, or there is no locating the node in a large schema.
    expect(() => generateModule(schema, 'M', 'probe.json')).toThrow(/\/\$defs\/X/)
  })

  // The other direction: legitimate shapes must not be caught by the new check. This is the
  // regression the change most needs to guard against. That the three real schemas regenerate
  // byte-for-byte unchanged is already covered by `gen:check` and the three "equals a fresh
  // generation" cases above; these pin a few shapes that are especially easy to catch by mistake.
  const NOT_DROPPED: Array<[string, Record<string, unknown>]> = [
    ['closed object', { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }],
    ['dictionary (Record<string,T>)', { type: 'object', additionalProperties: { type: 'string' } }],
    // presetId / resolvedPresetHash have exactly this shape: maxLength is vacuously true on the null
    // branch, so not generating it is correct under JSON Schema semantics, not a silent drop.
    ['type array + a constraint that binds only one branch', { type: ['string', 'null'], maxLength: 128 }],
    // Numeric formats are schemars width hints, and emit()'s integer branch never reads them.
    ['integer + numeric format', { type: 'integer', format: 'uint32', minimum: 0 }],
    ['a genuinely empty schema', {}],
    ['annotation keys only', { description: 'd', title: 't', 'x-hint': 1 }],
    [
      'enum + a sibling constraint every literal satisfies',
      { type: 'string', maxLength: 128, enum: ['a', 'b'] },
    ],
    ['const + a compatible type', { type: 'string', const: 'a' }],
  ]
  it.each(NOT_DROPPED)('does not throw for %s', (_name, node) => {
    expect(() => generateModule({ $defs: { X: node } }, 'M', 'probe.json')).not.toThrow()
  })
})

describe('generateModule: symmetric dependentRequired all-or-none groups', () => {
  const symmetric = {
    $defs: {
      Envelope: {
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'string' }, b: { type: 'integer' } },
        dependentRequired: { a: ['b'], b: ['a'] },
      },
    },
  }

  it('generates a validator that accepts absent/full and rejects either partial shape', async () => {
    const { stripTypeScriptTypes } = await import('node:module')
    const { Type } = await import('@sinclair/typebox')
    const source = stripTypeScriptTypes(generateModule(symmetric, 'Dependent'))
      .replace(/^import .*$/gm, '')
      .replace(/^export /gm, '')
    const generated = new Function('Type', `${source}\nreturn Dependent.Import('Envelope')`)(Type)
    expect(Value.Check(generated, {})).toBe(true)
    expect(Value.Check(generated, { a: 'x', b: 1 })).toBe(true)
    expect(Value.Check(generated, { a: 'x' })).toBe(false)
    expect(Value.Check(generated, { b: 1 })).toBe(false)
  })

  it('rejects asymmetric dependentRequired instead of silently approximating it', () => {
    const asymmetric = structuredClone(symmetric)
    asymmetric.$defs.Envelope.dependentRequired = { a: ['b'], b: [] } as never
    expect(() => generateModule(asymmetric, 'Dependent', 'probe.json')).toThrow(
      /only a symmetric all-or-none group is implemented/,
    )
  })
})

it('preserves schema-valued additionalProperties beside fixed object properties', async () => {
  const { stripTypeScriptTypes } = await import('node:module')
  const { Type } = await import('@sinclair/typebox')
  const source = stripTypeScriptTypes(
    generateModule(
      {
        $defs: {
          X: {
            type: 'object',
            required: ['type'],
            properties: { type: { const: 'object' } },
            additionalProperties: { type: 'string' },
          },
        },
      },
      'SchemaValuedAdditionalProperties',
    ),
  )
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '')
  const generated = new Function('Type', `${source}\nreturn SchemaValuedAdditionalProperties.Import('X')`)(
    Type,
  )
  expect(Value.Check(generated, { type: 'object', title: 'Fetch' })).toBe(true)
  expect(Value.Check(generated, { type: 'object', title: 1 })).toBe(false)
})

// Sibling constraints on a `const`/`enum` node: the literals already pin the value down, so a sibling
// is either redundant or self-contradictory. The defect where the enum branch ignored merged-in outer
// constraints — ajv saying false while TypeBox said true — becomes a generation-time throw here: no
// longer a disagreement between two validation libraries, but a module that cannot be generated.
describe('generateModule: contradictory sibling constraints on const/enum nodes', () => {
  it('throws when an enum literal violates a sibling maxLength', () => {
    const schema = { $defs: { X: { type: 'string', maxLength: 3, enum: ['ok', 'toolong'] } } }
    expect(() => generateModule(schema, 'M', 'probe.json')).toThrow(/contradictory schema/)
    expect(() => generateModule(schema, 'M', 'probe.json')).toThrow(/"toolong"/)
  })
  it('throws when a const value violates its own declared type', () => {
    const schema = { $defs: { X: { type: 'string', const: 42 } } }
    expect(() => generateModule(schema, 'M', 'probe.json')).toThrow(/contradictory schema/)
  })
  it('EventEnvelope.type (enum ∪ pattern under maxLength:128) is NOT contradictory', () => {
    const doc = JSON.parse(readFileSync(new URL('../schema/session-v1.json', import.meta.url), 'utf8'))
    expect(() => generateModule(doc, 'SessionV1', 'packages/protocol/schema/session-v1.json')).not.toThrow()
  })
})

// ── Two-way binding between UNSUPPORTED_NODES and the docs ──────────────────────────────────
// The registry is maintained entirely by hand, and adding a fifth entry without documenting it used
// to stay green — while `ACP_DEFS` already had a two-way comparison against UPSTREAM.md in
// ajv-parity.test.ts. One half of the same document was guarded and the other half was not.
// The related worry that the registry is opt-in, so a `not` on an unregistered node would be silently
// dropped, is answered by the leftover-key cases above: an unsupported keyword now always throws,
// forcing registration.
describe('UNSUPPORTED_NODES ↔ schema/acp/UPSTREAM.md + DEVIATIONS.md', () => {
  const upstreamMd = readFileSync(new URL('../schema/acp/UPSTREAM.md', import.meta.url), 'utf8')
  const deviationsMd = readFileSync(new URL('../schema/acp/DEVIATIONS.md', import.meta.url), 'utf8')
  const registered = [...UNSUPPORTED_NODES].sort()

  it('the node set listed in UPSTREAM.md equals UNSUPPORTED_NODES in code (both directions)', () => {
    // The first column of the UPSTREAM.md table is a full `<path>#/$defs/<Name>` pointer in backticks.
    const documented = [
      ...new Set(
        [...upstreamMd.matchAll(/`(packages\/protocol\/schema\/[^`]*#\/\$defs\/[A-Za-z0-9_]+)`/g)].map(
          (m) => m[1] as string,
        ),
      ),
    ].sort()
    expect(documented).toEqual(registered)
  })

  it('the U3 entry in DEVIATIONS.md names every registered node', () => {
    const u3 = deviationsMd.split('\n').find((l) => l.startsWith('| U3 |'))
    expect(u3, 'no U3 line found in DEVIATIONS.md').toBeDefined()
    for (const ptr of registered) expect(String(u3)).toContain(ptr.split('/').pop() as string)
  })

  it('every registered node really exists in the vendored schema.json (no zombie entries)', () => {
    const doc = JSON.parse(readFileSync(new URL('../schema/acp/schema.json', import.meta.url), 'utf8'))
    for (const ptr of registered) {
      const name = ptr.split('/').pop() as string
      expect(doc.$defs[name], `${name} is no longer in the vendored schema; remove its entry`).toBeDefined()
    }
  })
})

// The x-agnes-* top-level keys are declaration tables rather than shapes: emit() never sees them,
// and they reach the generated module verbatim so the validator and the packages downstream read
// the bytes the schema declares instead of a second hand-kept copy.
describe('emitExtras', () => {
  it('copies every x-agnes-* table out under its screaming-snake name, prefix included', () => {
    const src = generateModule({ 'x-agnes-data': { 'a/b': 'X' }, $defs: { X: { type: 'null' } } }, 'M')
    expect(src).toContain('export const X_AGNES_DATA = {\n  "a/b": "X"\n} as const')
  })
  it('leaves a document with no such table alone', () => {
    expect(generateModule({ $defs: { X: { type: 'null' } } }, 'M')).not.toContain('X_AGNES')
  })
  // The name is derived, so a second table has to come out under its own name rather than
  // overwriting the first.
  it('emits one constant per table', () => {
    const src = generateModule(
      { 'x-agnes-data': { 'a/b': 'X' }, 'x-agnes-max-bytes': 7, $defs: { X: { type: 'null' } } },
      'M',
    )
    expect(src).toContain('export const X_AGNES_DATA =')
    expect(src).toContain('export const X_AGNES_MAX_BYTES = 7 as const')
  })
})

// Execute the generated module, not a hand-built TypeBox equivalent. This catches losing either
// the negative assertion or a sibling before the source ever reaches a checked-in generated file.
describe('generateModule: not preserves every sibling assertion', () => {
  const cases = [
    {
      node: { type: 'string', pattern: '^[a-z]+$', not: { const: 'forbidden' } },
      yes: ['allowed'],
      no: ['forbidden', 'Bad', 4],
    },
    {
      node: { type: 'string', not: { enum: ['Inbox', 'Budget'] } },
      yes: ['refine'],
      no: ['Inbox', 'Budget', 4],
    },
    { node: { not: { const: 'x' } }, yes: ['y', 4, null], no: ['x'] },
    { node: { const: 'x', not: { const: 'y' } }, yes: ['x'], no: ['y', 4] },
    { node: { enum: ['x', 'y'], not: { const: 'y' } }, yes: ['x'], no: ['y', 'z'] },
    { node: { $ref: '#/$defs/Base', not: { const: 'no' } }, yes: ['yes'], no: ['no', 4] },
    {
      node: {
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'string' } },
        not: { const: null },
      },
      yes: [{ a: 'x' }],
      no: [{ b: 'x' }, null],
    },
    {
      node: {
        type: 'object',
        properties: { value: { type: 'string' } },
        not: { type: 'object', required: ['blocked'] },
      },
      yes: [{ value: 'x' }],
      no: [{ value: 'x', blocked: true }],
    },
  ]
  it.each(cases)('matches ajv for $node', async ({ node, yes, no }) => {
    const { createRequire, stripTypeScriptTypes } = await import('node:module')
    const { Type } = await import('@sinclair/typebox')
    const require = createRequire(import.meta.url)
    const Ajv = require('ajv/dist/2020.js').Ajv2020
    const doc = { $defs: { Base: { type: 'string' }, X: node } }
    const source = stripTypeScriptTypes(generateModule(doc, 'Negative'))
      .replace(/^import .*$/gm, '')
      .replace(/^export /gm, '')
    // The source is produced solely from these fixed schemas; no external code or input is evaluated.
    const generated = new Function('Type', `${source}\nreturn Negative.Import('X')`)(Type)
    const check = new Ajv({ strict: false }).compile({ ...doc, $ref: '#/$defs/X' })
    for (const value of yes) {
      expect(check(value)).toBe(true)
      expect(Value.Check(generated, value)).toBe(true)
    }
    for (const value of no) {
      expect(check(value)).toBe(false)
      expect(Value.Check(generated, value)).toBe(false)
    }
  })
  it('still refuses unimplemented constraints inside not or beside it', () => {
    for (const node of [{ not: { type: 'string', maxLenght: 2 } }, { not: { const: 'x' }, maxLenght: 2 }])
      expect(() => generateModule({ $defs: { X: node } }, 'Negative')).toThrow(/maxLenght/)
  })
})

describe('generateModule: required-only object properties', () => {
  const cases = [
    {
      node: { type: 'object', required: ['x'] },
      yes: [{ x: 1 }, { x: null, extra: true }],
      no: [{}, []],
    },
    {
      node: { type: 'object', required: ['x'], additionalProperties: false },
      yes: [],
      no: [{}, { x: 1 }],
    },
    {
      node: { type: 'object', required: ['x'], additionalProperties: { type: 'string' } },
      yes: [{ x: 'required' }, { x: 'required', extra: 'also-string' }],
      no: [{}, { x: 1 }, { x: 'required', extra: 1 }],
    },
  ]

  it.each(cases)('matches ajv for $node', async ({ node, yes, no }) => {
    const { createRequire, stripTypeScriptTypes } = await import('node:module')
    const { Type } = await import('@sinclair/typebox')
    const require = createRequire(import.meta.url)
    const Ajv = require('ajv/dist/2020.js').Ajv2020
    const doc = { $defs: { X: node } }
    const source = stripTypeScriptTypes(generateModule(doc, 'RequiredOnly'))
      .replace(/^import .*$/gm, '')
      .replace(/^export /gm, '')
    const generated = new Function('Type', `${source}\nreturn RequiredOnly.Import('X')`)(Type)
    const check = new Ajv({ strict: false }).compile({ ...doc, $ref: '#/$defs/X' })
    for (const value of yes) {
      expect(check(value)).toBe(true)
      expect(Value.Check(generated, value)).toBe(true)
    }
    for (const value of no) {
      expect(check(value)).toBe(false)
      expect(Value.Check(generated, value)).toBe(false)
    }
  })
})

it('preserves uniqueItems for projection event declarations', () => {
  expect(
    generateModule(
      { $defs: { Events: { type: 'array', items: { type: 'string' }, uniqueItems: true } } },
      'Events',
    ),
  ).toContain('uniqueItems: true')
})

it('preserves keyed dictionary min/max property counts against AJV', async () => {
  const { createRequire, stripTypeScriptTypes } = await import('node:module')
  const { Type } = await import('@sinclair/typebox')
  const require = createRequire(import.meta.url)
  const Ajv = require('ajv/dist/2020.js').Ajv2020
  const node = {
    type: 'object',
    propertyNames: { pattern: '^[a-z]+$' },
    additionalProperties: { type: 'string' },
    minProperties: 1,
    maxProperties: 2,
  }
  const doc = { $defs: { X: node } }
  const source = stripTypeScriptTypes(generateModule(doc, 'Dictionary'))
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '')
  const generated = new Function('Type', `${source}\nreturn Dictionary.Import('X')`)(Type)
  const check = new Ajv().compile(node)
  for (const [value, expected] of [
    [{ a: 'x' }, true],
    [{ a: 'x', b: 'y' }, true],
    [{}, false],
    [{ a: 'x', b: 'y', c: 'z' }, false],
    [{ A: 'x' }, false],
  ] as const) {
    expect(check(value)).toBe(expected)
    expect(Value.Check(generated, value)).toBe(expected)
  }
})
