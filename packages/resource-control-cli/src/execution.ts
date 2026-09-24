import { createInterface } from 'node:readline'
import type { NodeClient } from '@agnes/sdk'
import {
  type ResourceCommandKind,
  resourceCapabilityMissing,
  resourceCommandProfile,
  runResourceCommand,
} from './resources.js'

/** `profileName` is the profile scope the backend was booted for; requests may name no other. */
export type ResourceCliBoot = Readonly<{ client: NodeClient; profileName: string; close(): Promise<void> }>
export type ResourceCliIO = Readonly<{
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout: NodeJS.WritableStream & { isTTY?: boolean }
}>

/** Prompts only on an interactive terminal; a noninteractive resource mutation fails closed. */
export function confirmResourceOperation(io: ResourceCliIO, summary: string): Promise<boolean> {
  if (io.stdin.isTTY !== true || io.stdout.isTTY !== true) return Promise.resolve(false)
  return new Promise((resolve) => {
    const prompt = createInterface({ input: io.stdin, output: io.stdout, terminal: true })
    // EOF and Ctrl-C close the interface without ever calling the question callback. Settling as
    // "declined" keeps the fail-closed rule above. Resolve before close() below, which emits
    // 'close' synchronously and would otherwise bury the answer.
    prompt.once('close', () => resolve(false))
    prompt.question(`${summary}. Continue? [y/N] `, (answer) => {
      resolve(/^y(?:es)?$/i.test(answer.trim()))
      prompt.close()
    })
  })
}

/** Owns resource-command profile selection, backend lifetime and compatibility handling. */
export async function runResourceCliCommand(
  input: Readonly<{
    kind: ResourceCommandKind
    rest: readonly string[]
    boot(profile: string | undefined): Promise<ResourceCliBoot>
    write(text: string): void
    confirm(summary: string): Promise<boolean>
    unavailable(error: unknown): never
  }>,
): Promise<void> {
  const profile = resourceCommandProfile(input.rest)
  const booted = await input.boot(profile)
  // Without --profile the backend still boots for a profile (AGNES_PROFILE or local-dev); the
  // command must name that one rather than the parser's fixed local-dev default.
  const argv = profile === undefined ? ['--profile', booted.profileName, ...input.rest] : input.rest
  try {
    try {
      await runResourceCommand(input.kind, argv, booted.client, {
        write: input.write,
        confirm: input.confirm,
      })
    } catch (error) {
      if (resourceCapabilityMissing(error)) input.unavailable(error)
      throw error
    }
  } finally {
    await booted.close().catch(() => undefined)
  }
}
