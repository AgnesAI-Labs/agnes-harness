/** Compatibility facade; DTO schemas stay below Protocol and do not widen its runtime root. */

export type {
  ResourceControlAccessPolicy,
  ResourceControlDataName,
  ResourceControlMethodName,
} from '../../resource-control-contracts/src/resource-control.js'
export {
  canAccessResourceControl,
  RESOURCE_CONTROL_METHODS,
  RESOURCE_CONTROL_PERMISSIONS,
  validateResourceControlCall,
  validateResourceControlData,
} from '../../resource-control-contracts/src/resource-control.js'
