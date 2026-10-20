export type Text = { en: string; 'zh-CN': string }
export const text = (zh: string, en: string): Text => ({ 'zh-CN': zh, en })
export type Method = 'test' | 'analysis' | 'inspection' | 'demonstration'
export type Requirement = {
  id: string
  parent: string | null
  title: Text
  method: Method
  design: string[]
  tests: string[]
  verified: boolean
}
export type TestCase = {
  id: string
  title: Text
  status: 'passed' | 'failed' | 'pending'
  configuration: string
  evidence: string
}
export type Sample = {
  minute: number
  current: number
  temperature: number
  pressure: number
  limit: number
  anomaly: boolean
}
export type Campaign = {
  id: string
  title: Text
  status: string
  configuration: string
  unit: string
  lot: string
  started: string
  samples: Sample[]
  logs: { at: string; message: Text }[]
}
export type Disposition = 'use-as-is' | 'rework' | 'repair' | 'scrap' | 'return-to-supplier'
export type Ncr = {
  id: string
  title: Text
  severity: string
  status: string
  opened: string
  lot: string
  unit: string
  signature: Text
  disposition: Disposition | null
  rationale: string
  approvals: string[]
  evidence: string[]
}
export type Ecr = {
  id: string
  title: Text
  status: string
  from: string
  to: string
  part: string
  lotChange: boolean
  thermallyCycled: boolean
  requirements: string[]
  interfaces: string[]
  tests: string[]
  rationale: string
  approvals: string[]
}
export type Criterion = { id: string; title: Text; evidence: string[]; accepted: boolean }
export type Zeroing = {
  id: string
  anomaly: string
  status: string
  criteria: Criterion[]
  closure?: {
    decisionId: string
    signer: string
    confirmationMode: string
    meaning?: string
    reviewedRevision: number
    subjectRevision: string
  }
}
export type Part = {
  id: string
  title: Text
  supplier: Text
  grade: string
  lot: string
  preferred: boolean
  obsolete: boolean
  counterfeitRisk: boolean
  status: string
}
export type Audit = {
  confirmationMode?: string
  signer?: string
  signatureMeaning?: string
  id: string
  at: string
  action: string
  subject: string
  approval: string | null
  revision: number
}
export type State = {
  schema: 1
  revision: number
  requirements: Requirement[]
  tests: TestCase[]
  campaigns: Campaign[]
  ncrs: Ncr[]
  ecrs: Ecr[]
  zeroing: Zeroing[]
  parts: Part[]
  baselines: { id: string; status: string; units: string[]; source: string }[]
  milestones: { date: string; title: Text; status: string }[]
  rule: {
    status: 'absent' | 'review' | 'active'
    version: number
    body: string
    evidence: string[]
    approval: string | null
  }
  audit: Audit[]
}

/** Format only the recorded mode; absent or unknown proof is never labelled manual. */
export function confirmationLabel(mode: string | undefined, principal: string, locale: 'zh-CN' | 'en') {
  const zh = locale === 'zh-CN'
  if (mode === 'auto-confirmed under full access')
    return zh
      ? `完全访问下自动确认（主体 ${principal}）`
      : `Auto-confirmed under full access (principal ${principal})`
  if (mode === 'manual') return zh ? `已由真人签署: ${principal}` : `Signed by ${principal}`
  return zh
    ? `确认方式未记录（主体 ${principal}）`
    : `Confirmation mode not recorded (principal ${principal})`
}
