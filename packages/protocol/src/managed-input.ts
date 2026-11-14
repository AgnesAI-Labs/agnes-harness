/**
 * Owner input review: what `managedInput.get` reads and `managedInput.decide` takes. Only the owner's
 * Web page may call either; the shapes are owned by protocol schemas.
 */
export type {
  ManagedInputDecideParams,
  ManagedInputDecideResult,
  ManagedInputGetParams,
  ManagedInputGetResult,
} from '../gen/ts/agnes-v1.js'
