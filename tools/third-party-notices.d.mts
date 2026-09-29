export function collectThirdPartyNotices(
  workingDirectory: string,
  outputDirectory: string,
  builds: readonly { metafile?: { inputs: Record<string, unknown> } | undefined }[],
): Promise<void>
