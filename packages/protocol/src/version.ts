/**
 * The harness version a deploy manifest's `harnessRange` is checked against.
 *
 * This is a contract version, not a build label: an unpublished development build reports `0.0.0`
 * as its own version and must still accept the manifests written for this contract. It is written
 * here once and pinned to this package's manifest version by a test, as the Extension API version is.
 */
export const HARNESS_VERSION = '0.1.0' as const
