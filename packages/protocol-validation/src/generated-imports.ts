import { Kind, type TImport, type TModule, type TProperties } from '@sinclair/typebox'

const definitions = new WeakMap<object, TProperties>()

/** Generator-only imports without per-export copies of the same immutable reference table.
 * Call prepareValidationSchemas on the complete export set before publishing the module. */
export function importValidationSchema<P extends TProperties, C extends TProperties, K extends keyof C>(
  module: TModule<P, C>,
  key: K,
): TImport<C, K> {
  let shared = definitions.get(module)
  if (!shared) {
    // Let the pinned TypeBox module resolve/compute its definitions. No alternate schema lowering.
    shared = module.Import(key).$defs
    definitions.set(module, shared)
  }
  if (!Object.hasOwn(shared, key)) return module.Import(key)
  // TImport's static/params fields are phantom TypeBox typing; these are its complete wire fields.
  return { [Kind]: 'Import', $defs: shared, $ref: key } as TImport<C, K>
}
