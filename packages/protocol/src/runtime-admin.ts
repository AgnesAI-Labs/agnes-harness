import { type Static, Type } from '@sinclair/typebox'

const text = Type.String({ minLength: 1, maxLength: 1024 })
const strings = Type.Array(text, { maxItems: 4096 })
export const RuntimeAdminEmpty = Type.Object({}, { additionalProperties: false })
export const RuntimePublicationReport = Type.Object(
  {
    operation: Type.Union([
      Type.Literal('runtime-target'),
      Type.Literal('skills'),
      Type.Literal('models'),
      Type.Literal('extension-rows'),
    ]),
    ok: Type.Boolean(),
    recovery: Type.Literal('retry-same-input'),
    containers: Type.Array(
      Type.Object(
        { compositionHash: text, status: Type.Union([Type.Literal('applied'), Type.Literal('failed')]) },
        { additionalProperties: false },
      ),
      { maxItems: 4096 },
    ),
  },
  { additionalProperties: false },
)
export type RuntimePublicationReport = Static<typeof RuntimePublicationReport>
/** Description-only catalog. No factories, preset config, credentials or source bytes. */
export const RuntimeAdminSnapshot = Type.Object(
  {
    providers: Type.Array(
      Type.Object(
        {
          kind: text,
          id: text,
          version: text,
          sourcePackage: text,
          capabilities: strings,
          restartRequired: Type.Boolean(),
          active: Type.Boolean(),
          selectedFor: strings,
          scope: Type.Optional(
            Type.Union([
              Type.Literal('session'),
              Type.Literal('generation'),
              Type.Literal('workspace'),
              Type.Literal('process'),
            ]),
          ),
        },
        { additionalProperties: false },
      ),
      { maxItems: 4096 },
    ),
    presets: Type.Array(
      Type.Object({ id: text, isDefault: Type.Boolean() }, { additionalProperties: false }),
      { maxItems: 256 },
    ),
    localPluginFolders: Type.Object({ home: text, workspace: text }, { additionalProperties: false }),
    publication: Type.Optional(RuntimePublicationReport),
  },
  { additionalProperties: false },
)
export type RuntimeAdminSnapshot = Static<typeof RuntimeAdminSnapshot>
