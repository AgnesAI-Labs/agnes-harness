import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  type ConformanceReport,
  judgeReport,
  type ReportDraft,
  serializeReport,
} from '../../../packages/extension-api/testkit/index.js'

export type {
  AssertionRecord,
  ConformanceReport,
  ReportDraft,
  ReportFailure,
} from '../../../packages/extension-api/testkit/index.js'
export { judgeReport, serializeReport }

export interface MergeShell {
  readonly command: string
  readonly startedAt: string
  readonly finishedAt: string
}

export function mergeReports(reports: readonly ConformanceReport[], shell: MergeShell): ConformanceReport {
  const joined = reports
    .map((report) => report.command)
    .filter((command) => command !== '')
    .join('\n')
  const draft: ReportDraft = {
    contracts: reports.flatMap((report) => report.contracts),
    providers: reports.flatMap((report) => report.providers),
    unknownContracts: reports.flatMap((report) => report.unknownContracts),
    command: joined !== '' ? joined : shell.command,
    startedAt: shell.startedAt,
    finishedAt: shell.finishedAt,
    assertions: reports.flatMap((report) => report.assertions),
  }
  return judgeReport(draft)
}

export function writeReport(path: string, report: ConformanceReport): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializeReport(report))
}
