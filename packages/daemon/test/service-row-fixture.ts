import { createHash } from 'node:crypto'

export const servicePackageId = '@agnes-test/reports'
export const serviceRowId = 'ext:agnes/reports/main'
export const serviceOwner = `plugin/${createHash('sha256').update(serviceRowId).digest('hex').slice(0, 16)}`
export const serviceSnapshotId = `sha256-${'8'.repeat(64)}`
