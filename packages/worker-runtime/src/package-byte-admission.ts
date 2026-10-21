import type { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ResolvedProfile } from '@agnes/host'
import { type PackageBootAdmission, PackageByteVerification } from '@agnes/package-manager'

/** Startup input over the already-private fork IPC; never a session request or a worker verdict. */
export async function workerByteAdmission(
  env: NodeJS.ProcessEnv,
  home: string,
  channel: Pick<EventEmitter, 'on' | 'off' | 'once'> & {
    send?(input: Record<string, unknown>): unknown
  } = process,
): Promise<
  | {
      owner: PackageByteVerification
      admission: PackageBootAdmission
    }
  | undefined
> {
  if (env.AGNES_PACKAGE_BYTE_ADMISSION !== '1') return undefined
  const profile = JSON.parse(readFileSync(env.AGNES_PROFILE_FILE!, 'utf8')) as ResolvedProfile
  const admission = await new Promise<PackageBootAdmission>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      channel.off('message', receive)
      channel.off('disconnect', disconnected)
    }
    const disconnected = () => {
      cleanup()
      reject(new Error('package admission parent disconnected'))
    }
    const receive = (input: unknown) => {
      if (
        !input ||
        typeof input !== 'object' ||
        !('kind' in input) ||
        input.kind !== 'package-byte-admission'
      )
        return
      cleanup()
      const frame = input as {
        token?: unknown
        generation?: unknown
        profileHash?: unknown
        admission?: PackageBootAdmission
      }
      const value = frame.admission
      if (
        frame.token !== env.AGNES_WORKER_TOKEN ||
        frame.generation !== Number(env.AGNES_WORKER_GENERATION) ||
        frame.profileHash !== profile.hash ||
        !value ||
        typeof value.binding !== 'string' ||
        !Array.isArray(value.trees) ||
        value.trees.length > 4096 ||
        !value.trees.every(
          (tree) =>
            tree !== null &&
            typeof tree === 'object' &&
            typeof tree.directory === 'string' &&
            tree.identity &&
            typeof tree.identity.version === 'string' &&
            typeof tree.identity.capabilityHash === 'string' &&
            typeof tree.identity.integrity === 'string' &&
            /^sha256-[a-f0-9]{64}$/.test(tree.identity.treeIntegrity ?? ''),
        )
      ) {
        reject(new Error('invalid package startup admission'))
        return
      }
      resolve(value)
    }
    const timer = setTimeout(disconnected, 2000)
    channel.on('message', receive)
    channel.once('disconnect', disconnected)
    if (!channel.send) {
      disconnected()
      return
    }
    channel.send({ kind: 'package-admission-ready', token: env.AGNES_WORKER_TOKEN })
  })
  const profileDir = join(home, 'profiles', profile.name)
  const owner = new PackageByteVerification({
    profileDir,
    startupAdmission: admission,
    roots: [profileDir, join(profile.dataDir, 'profiles', profile.name, 'packages')],
    onMismatch(failure) {
      // Only a negative observation crosses back. Stop the process instead of waiting for a
      // profile write while its Host might still hold a publication read ticket.
      process.send?.({ kind: 'package-byte-failure', token: env.AGNES_WORKER_TOKEN, failure }, () =>
        process.exit(1),
      )
      setTimeout(() => process.exit(1), 100).unref()
    },
  })
  return { owner, admission }
}
