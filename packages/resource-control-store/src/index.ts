export type { McpLifecycleAdapter, SkillCatalogAdapter, SkillCatalogCandidate } from './adapters.js'
export {
  createResourceAdminSurface,
  type ResourceAdminSurfaceAction,
  type ResourceAdminSurfaceOptions,
} from './admin-surface.js'
export { createResourceControlStore, ResourceControlStore } from './control-store.js'
export {
  createResourceControlService,
  type ResourceControlService,
  type ResourceStateStore,
  registerResourceControl,
} from './handler.js'
export { McpResourceStore } from './mcp.js'
export {
  denyResourceAuthority,
  localResourceAuthority,
  RESOURCE_ALL_PERMISSIONS,
  type ResourceAuthority,
  type ResourceAuthorityResolver,
  requireResourceAuthority,
  requireSecretUse,
} from './permissions.js'
export { assertResourceProfile, type ResourceProfileScope } from './profile-scope.js'
export { type SkillJournal, SkillJournalStore } from './skill-journal.js'
export { createSkillResourceStore, SkillResourceStore } from './skills.js'
