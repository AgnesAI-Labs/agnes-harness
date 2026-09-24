// `@agnes/extension-api` 的作者面版本号（规格 §19，独立 semver）。清单 `apiRange` 与它比对，
// 不合判 `E_API_RANGE`。03 Task 9 会把这个常量挪进 `version.ts` 并由本文件转出；在那之前它住这里。

export * from './api-range.js'

export * from './common.js'
export * from './errors.js'
export * from './extension.js'
export { HOOK_TABLE } from './generated/hook-table.js'
export { SLOT_TABLE } from './generated/slot-table.js'
export * from './hooks.js'
export * from './manifest.js'
export * from './plugin-extension.js'
export * from './projections.js'
export * from './resources.js'
export * from './services.js'
export * from './skill-install.js'
export * from './slots.js'
export * from './tool.js'
export * from './version.js'
export * from './workspace-hooks.js'
