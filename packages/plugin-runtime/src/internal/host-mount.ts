import type { EntryRow } from '@agnes/cordis-loader'
import type {
  BuiltinRowMountFactory,
  VerifiedExtrasEnvelope,
  VerifiedRowEntry,
  VerifiedRowMount,
} from '../row-mount.js'

type BuiltinInput = Readonly<{
  row: Readonly<EntryRow>
  entry: VerifiedRowEntry
  extras?: VerifiedExtrasEnvelope
}>

/** Host-private builtin source. D74 trusts the desired row's existing mount identity. */
export function createBuiltinRowMountFactory(
  options: Readonly<{
    allowedRowIds: ReadonlySet<string>
    allowedProvides: ReadonlySet<string>
    allowTestRows: boolean
    create(input: BuiltinInput): VerifiedRowMount
  }>,
): BuiltinRowMountFactory {
  return Object.freeze({
    async create(input: BuiltinInput) {
      if (!options.allowTestRows && !options.allowedRowIds.has(input.row.id)) {
        throw new Error(`E_BUILTIN_ROW: builtin row is not allowed: ${input.row.id}`)
      }
      const unknown = input.row.provides.find(
        (name) => !options.allowTestRows && !options.allowedProvides.has(name),
      )
      if (unknown) throw new Error(`E_BUILTIN_PROVIDE: builtin provide is not allowed: ${unknown}`)
      return options.create(input)
    },
  })
}
