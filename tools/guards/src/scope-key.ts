import { sep } from 'node:path'
import { SOURCE_EXTENSIONS } from './repo.js'

// A scope key abs (already made absolute) should cover exactly two file forms: a file that is exactly
// `${abs}<source extension>`, or anything under `${abs}/`. A bare string startsWith(abs) will not do, because it also
// pulls in sibling files sharing the prefix, such as assemble-legacy.ts.
// Shared by scope-line-count.test.ts and kernel-create.test.ts so the two cannot drift apart.
export function matchesScopeKey(file: string, abs: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => file === `${abs}${ext}`) || file.startsWith(`${abs}${sep}`)
}
