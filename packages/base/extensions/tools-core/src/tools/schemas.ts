import { Type } from '@sinclair/typebox'

// Parameter schemas for the core tools. They are the model-visible face of this package and are
// hashed into the prompt, so they must be byte-identical wherever agnes runs: no platform wording,
// no host-dependent defaults, and no properties beyond the ones listed.
const Path = Type.String({ minLength: 1, maxLength: 4096 })

export const ReadParams = Type.Object(
  {
    path: Path,
    offset: Type.Optional(Type.Integer({ minimum: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
)

export const ShellParams = Type.Object(
  {
    command: Type.String({ minLength: 1 }),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    cwd: Type.Optional(Path),
    background: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

export const WriteParams = Type.Object(
  { path: Path, content: Type.String() },
  { additionalProperties: false },
)

export const EditParams = Type.Object(
  {
    path: Path,
    edits: Type.Array(
      Type.Object(
        { oldText: Type.String({ minLength: 1 }), newText: Type.String() },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
)

export const GrepParams = Type.Object(
  {
    pattern: Type.String({ minLength: 1 }),
    path: Type.Optional(Path),
    glob: Type.Optional(Type.String()),
    ignoreCase: Type.Optional(Type.Boolean()),
    literal: Type.Optional(Type.Boolean()),
    context: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  { additionalProperties: false },
)

export const FindParams = Type.Object(
  {
    pattern: Type.String({ minLength: 1 }),
    path: Type.Optional(Path),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
  },
  { additionalProperties: false },
)

export const LsParams = Type.Object(
  { path: Type.Optional(Path), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })) },
  { additionalProperties: false },
)

// minItems 1 on purpose. `plan.items` is a whole-register replace, so an empty list would clear
// the plan - and clearing a plan should be something the model asked for, not the side effect of a
// call that carried nothing. `blocked` is deliberately absent from the model's three values: being
// blocked is a judgement about the world that the operator and the kernel make, not the model.
export const TodoParams = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          content: Type.String({ minLength: 1 }),
          status: Type.Union([
            Type.Literal('pending'),
            Type.Literal('in_progress'),
            Type.Literal('completed'),
          ]),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
)
