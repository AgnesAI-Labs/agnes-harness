/**
 * Compatibility facade for the legacy Web source path.
 *
 * The component implementation lives in the independently addressable
 * `@agnes/web-units` package. Host-only navigation and shell adapters are
 * injected by `region-slots.ts` so this package does not depend back on Web.
 */
export {
  EMPTY_SIDEBAR_STATE,
  type SessionAction,
  Sidebar,
  type SidebarActions,
  type SidebarDependencies,
  type SidebarHandle,
  type SidebarNavigationOptions,
  type SidebarShell,
  type SidebarState,
} from '@agnes/web-units'
