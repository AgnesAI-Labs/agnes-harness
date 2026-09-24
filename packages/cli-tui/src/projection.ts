// The projection engine lives in the SDK so the TUI and the Web workbench share one implementation;
// the TUI keeps its original names.
export {
  applyUITimelinePatch,
  applyWindowedUITimelinePatch,
  MAX_DEFERRED_UI_OVERLAYS,
  OPENING_RETRY_MS,
  REPROJECT_DEBOUNCE_MS,
  UIProjectionSync as TuiProjection,
  type UIProjectionWindow as TuiProjectionWindow,
} from '@agnes/sdk'
