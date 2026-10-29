export type SnapshotPluginLocator = Readonly<{
  packageId: string
  snapshotId: string
  exportName: string
  contributionId?: string
}>

/** `<package>@<snapshot>/<export>`, or `<package>@<snapshot>/client/<contribution-id>`. */
export function parseSnapshotPluginLocator(value: string): SnapshotPluginLocator | undefined {
  const match = /^((?:@[^/@]+\/)?[^@]+)@(sha512-[A-Za-z0-9+/]{86}==|[^/@]+)\/([^/]+)(?:\/(.+))?$/.exec(value)
  if (!match || value.includes('\0') || /\s/u.test(value)) return undefined
  const [, packageId, snapshotId, exportName, contributionId] = match
  if (
    contributionId !== undefined &&
    (exportName !== 'client' || contributionId.endsWith('/') || contributionId.includes('//'))
  )
    return undefined
  return Object.freeze({
    packageId: packageId!,
    snapshotId: snapshotId!,
    exportName: exportName!,
    ...(contributionId === undefined ? {} : { contributionId }),
  })
}

export function formatSnapshotPluginLocator(input: SnapshotPluginLocator): string {
  const value = `${input.packageId}@${input.snapshotId}/${input.exportName}${input.contributionId === undefined ? '' : `/${input.contributionId}`}`
  const parsed = parseSnapshotPluginLocator(value)
  if (
    !parsed ||
    parsed.packageId !== input.packageId ||
    parsed.snapshotId !== input.snapshotId ||
    parsed.exportName !== input.exportName ||
    parsed.contributionId !== input.contributionId
  )
    throw new Error('Invalid snapshot plugin locator')
  return value
}
