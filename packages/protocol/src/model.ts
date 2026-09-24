import * as M from '../gen/ts/model.js'
import { type ValidationResult, validateAgainst } from './validate.js'

// AI_ERROR_CODES / SLOT_NAMES and their types are deliberately not redeclared here. They already
// exist on src/provider.ts, are consumed by core's request builder and by the host's route
// assembly, and are pinned by test/boundary.test.ts. Two tuples for one closed set is exactly the
// drift a second declaration in this file would start.

export const validateModelRecord = (x: unknown): ValidationResult<M.ModelRecord> =>
  validateAgainst<M.ModelRecord>(M.ModelRecord, x)
export const validateRouteTable = (x: unknown): ValidationResult<M.RouteTable> =>
  validateAgainst<M.RouteTable>(M.RouteTable, x)
export const validateContractStamp = (x: unknown): ValidationResult<M.ContractStamp> =>
  validateAgainst<M.ContractStamp>(M.ContractStamp, x)
export const validateContractManifest = (x: unknown): ValidationResult<M.ContractManifest> =>
  validateAgainst<M.ContractManifest>(M.ContractManifest, x)
