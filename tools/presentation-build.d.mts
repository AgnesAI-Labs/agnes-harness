export type PresentationBuild = {
  schemaVersion: number
  name: string
  entry: string
  esbuildVersion: string
  inputHash: string
  inputs: string[]
  bytes: number
  files: Record<string, string>
}
export const presentationRoot: string
export const presentationEntries: Record<string, string>
export function buildPresentations(options?: {
  /** Alternate payload output directory; compilation still reads the real source inputs. */
  outputRoot?: string
  check?: boolean
  force?: boolean
}): Promise<PresentationBuild[]>
export function verifyPresentation(root: string): Promise<PresentationBuild>
