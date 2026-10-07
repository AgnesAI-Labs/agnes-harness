export function collectThirdPartyNotices(
  workingDirectory: string,
  outputDirectory: string,
  builds: readonly { metafile?: { inputs: Record<string, unknown> } | undefined }[],
  fallbackLicenses?: Readonly<Record<string, string>>,
): Promise<void>
