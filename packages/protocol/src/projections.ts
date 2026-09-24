import { ProjectionCapability, ProjectionReadResult } from '../gen/ts/projection.js'
import { type ValidationResult, validateAgainst } from './validate.js'
export const validateProjectionCapability = (value: unknown): ValidationResult<ProjectionCapability> =>
  validateAgainst(ProjectionCapability, value)
export const validateProjectionReadResult = (value: unknown): ValidationResult<ProjectionReadResult> =>
  validateAgainst(ProjectionReadResult, value)
