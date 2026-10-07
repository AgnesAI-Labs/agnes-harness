# Core file and shell tools

Official definitions use the public extension tool context. `write` and `edit` refuse existing files without a successful text read in the same session (`FS_NOT_OBSERVED`); successful writes also observe their new version. Stale-write, truncation and binary-edit guards remain active. Observations are bounded and process-local.

`shell` uses the session jobs registry for explicit background and foreground-timeout continuation. Shutdown hooks clean jobs even when tools-core is loaded alone. See [default tools](../../../../docs/reference/default-tools.md) for job controls, paging and limits.
