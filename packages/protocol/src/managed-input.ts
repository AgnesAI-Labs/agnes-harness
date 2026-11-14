/**
 * Owner input review: what `managedInput.list` and `managedInput.get` read and `managedInput.decide`
 * takes. Only the owner's Web page may call them; the shapes are owned by protocol schemas.
 */
export type {
  ManagedInputDecideParams,
  ManagedInputDecideResult,
  ManagedInputGetParams,
  ManagedInputGetResult,
  ManagedInputListParams,
  ManagedInputListResult,
} from '../gen/ts/agnes-v1.js'
