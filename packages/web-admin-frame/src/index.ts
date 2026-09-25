// Remaining imperative DOM utilities consumed outside the admin two-station surfaces.
// The component pieces (tabs/confirm/select-picker/state-controls/popover) moved to
// @agnes/web-ui with the web-ui component system (spec 2026-09-24 §4); the survivors here
// serve the conversation-area files (markdown/turns/usage) and shell-level dialogs, which
// belong to other worklines. This package is scheduled for full removal once those lines
// migrate (web-ui line-c plan, C-4).
export * from './binding.js'
export * from './text-reveal.js'
