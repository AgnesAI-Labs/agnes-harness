import { Type } from '@sinclair/typebox'

/**
 * The closed Windows partial contract a local Windows Host runs commands under: writes limited by
 * file ACLs, reads and network not isolated, the process tree owned by a job object. Any other shape
 * is not this contract. A reader that does not know the field still sees `level: 'partial'`.
 */
export const windowsWriteBoundary = Type.Object(
  {
    contract: Type.Literal('windows-write-restricted-v1'),
    fileWrite: Type.Literal('acl-partial'),
    fileRead: Type.Literal('unrestricted'),
    network: Type.Literal('unrestricted'),
    processTree: Type.Literal('job-object'),
  },
  { additionalProperties: false },
)
