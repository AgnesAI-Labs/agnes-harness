import { sep } from 'node:path'

// A ratchet key abs (already made absolute) should cover exactly two file forms: a file that is exactly
// `${abs}.ts`, or anything under `${abs}/`. A bare string startsWith(abs) will not do, because it also
// pulls in sibling files sharing the prefix, such as assemble-legacy.ts.
// Shared by ratchet.test.ts and kernel-create.test.ts so the two cannot drift apart.
export function matchesRatchetKey(file: string, abs: string): boolean {
  return file === `${abs}.ts` || file.startsWith(`${abs}${sep}`)
}
