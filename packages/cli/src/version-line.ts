/**
 * The one line `agh --version` prints. Shared by the full entry and the launch bootstrap, which
 * answers `--version` without loading the main bundle, so the two cannot drift apart: scripts parse
 * this line.
 */
export function versionLine(agnesVersion: string, nodeVersion: string = process.versions.node): string {
  return `agh ${agnesVersion} node ${nodeVersion} protocol _agnes/v1\n`
}
