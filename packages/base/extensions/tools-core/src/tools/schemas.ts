import { Type } from '@sinclair/typebox'

// Parameter schemas for the core tools. They are the model-visible face of this package and are
// hashed into the prompt, so they must be byte-identical wherever agnes runs: no platform wording,
// no host-dependent defaults, and no properties beyond the ones listed.
const Path = Type.String({ minLength: 1, maxLength: 4096 })

export const ReadParams = Type.Object(
  {
    path: Path,
    save_to: Type.Optional(Path),
    max_edge: Type.Optional(Type.Integer({ minimum: 8, maximum: 1456 })),
    offset: Type.Optional(Type.Integer({ minimum: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
)

export const ShellParams = Type.Object(
  {
    command: Type.String({ minLength: 1 }),
    description: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 1024,
        description:
          'Brief human-readable action, affected files or scope, and purpose. Shown before approval; the command remains in technical details.',
      }),
    ),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    cwd: Type.Optional(Path),
    background: Type.Optional(Type.Boolean()),
    timeoutToBackground: Type.Optional(Type.Boolean()),
    persistent: Type.Optional(Type.Boolean()),
    shell: Type.Optional(Type.Union([Type.Literal('bash'), Type.Literal('zsh'), Type.Literal('pwsh')])),
    sessionId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
)

// `allowShrink` is the one way to confirm that an overwrite is meant to leave the file much
// smaller. It only reaches the size check: read-first and stale-read refusals come before it, so it
// can only apply to the version of the file the model actually read.
export const WriteParams = Type.Object(
  {
    path: Path,
    content: Type.String(),
    allowShrink: Type.Optional(
      Type.Boolean({
        description:
          'Set true only to confirm that content is intentionally much shorter than the existing file (for example, a section deleted or a merge conflict resolved), after a truncation guard refusal or when you know the file shrinks by more than half. Leave unset otherwise.',
      }),
    ),
  },
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
