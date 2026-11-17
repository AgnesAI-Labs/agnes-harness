// The harness's directory layout names. This module imports nothing, so a bundled plugin that needs
// only these names can import `@agnes/protocol/layout` without bundling the protocol schemas.

/**
 * The harness's own directory name: `<os home>/.agh` by default, and `<workspace>/.agh` in every
 * workspace. It is not `.agnes` because another product already owns that name on the same machines.
 */
export const AGH_DIR = '.agh'
/**
 * AGH-owned workspace-relative directories every file tool and sandbox hard-denies.
 */
export const WORKSPACE_SECRET_DIRS = ['.agh/secrets'] as const
