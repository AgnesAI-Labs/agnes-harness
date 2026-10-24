import { accessSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/** Both test projects exercise native contracts. Fail before collection with exact repair steps. */
export default function setup() {
  const host = 'mise exec -- node tools/toolchain/run.mjs --filter @agnes/host build:native'
  const system = 'mise exec -- node tools/toolchain/run.mjs --filter @agnes/system-node build:native'
  const missing = new Set()
  const executable = (relative) => {
    try {
      accessSync(fileURLToPath(new URL(relative, import.meta.url)), constants.X_OK)
    } catch {
      missing.add(host)
    }
  }
  if (process.platform === 'darwin') {
    executable('../packages/host-infrastructure/dist/native/macos-process-identity')
    executable('../packages/host-computer-use/dist/native/macos-live-app-identity')
  }
  if (process.platform === 'darwin' || process.platform === 'linux')
    executable('../packages/host-infrastructure/dist/native/pty-relay')
  if (['darwin', 'linux', 'win32'].includes(process.platform)) {
    try {
      const require = createRequire(new URL('../packages/system-node/package.json', import.meta.url))
      const native = require('@agnes/system-node/native')
      const methods =
        process.platform === 'darwin'
          ? ['deletePrivateArtifact', 'syncDescriptor', 'openUnixListener']
          : process.platform === 'linux'
            ? ['deletePrivateArtifact', 'openCanonicalFile', 'landlockAbi']
            : ['deletePrivateArtifact', 'processStartTime', 'createProcessJob']
      if (native.abiVersion !== 1 || methods.some((name) => typeof native[name] !== 'function'))
        missing.add(system)
    } catch {
      missing.add(system)
    }
  }
  if (missing.size)
    throw new Error(
      `Test native prerequisites are missing or stale. Run from the repository root:\n${[...missing].join('\n')}`,
    )
}
