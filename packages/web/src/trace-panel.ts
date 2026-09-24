/**
 * Compatibility facade for consumers that still import the legacy Web source path.
 * The implementation and pure trace helpers live in the independent web-units package.
 */
export type {
  TraceHandle,
  TracePanel,
  TracePanelOptions,
  TraceProps,
} from '@agnes/web-units'
export {
  durationLabel,
  TRACE_PANEL_STORAGE_KEY,
  Trace,
} from '@agnes/web-units'
