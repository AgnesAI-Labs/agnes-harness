// The path identity the file tools and the Host's command table both resolve against lives in
// core-common, so one fold decides what is inside a workspace.
export { type NormalizedPath, normalizeWorkspacePath } from '@agnes/core-common/workspace-path'
