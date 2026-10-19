export type L = { en: string; 'zh-CN': string }
export const label = (zh: string, en: string): L => ({ en, 'zh-CN': zh })
export type Measurement = {
  id: string
  name: L
  value: number
  unit: string
  min: number
  max: number
  at: string
  source: string
}
export type Signature = { actor: string; at: string; meaning: L }
export type Step = {
  id: string
  name: L
  equipment: string
  room: string
  at: string
  cpp: Measurement[]
  operator: Signature
  verifier: Signature | null
}
export type Batch = {
  id: string
  product: L
  form: 'tablet' | 'capsule'
  size: number
  date: string
  status: 'production' | 'review' | 'released'
  review: 'pending' | 'findings' | 'accepted'
  steps: Step[]
  qc: Measurement[]
  deviationIds: string[]
  retests: Measurement[]
  certificate: Certificate | null
}
export type Certificate = {
  id: string
  batch: string
  at: string
  signer: string
  meaning: string
  approvalId: string
  subjectRevision: string
  dossierRevision: number
}
export type Capa = { id: string; text: L; owner: string; due: string; evidence: string; effective: boolean }
export type Deviation = {
  id: string
  batch: string
  severity: 'minor' | 'major' | 'critical'
  title: L
  stage: 'open' | 'investigation' | 'capa' | 'effectiveness' | 'closed'
  opened: string
  cause: string
  impact: string[]
  why: string[]
  actions: Capa[]
}
export type Equipment = {
  id: string
  name: L
  due: string
  qualification: 'qualified' | 'suspended'
  calibrated: string
  evidence: string[]
}
export type Room = {
  id: string
  grade: 'A' | 'B' | 'C' | 'D'
  name: L
  viableAlert: number
  viableAction: number
  particleAlert: number
  particleAction: number
}
export type Sample = {
  id: string
  room: string
  batch: string
  at: string
  viable: number
  particles: number
  disposition: 'pending' | 'assessed'
  evidence: string
}
export type Audit = {
  signatureMeaning?: string
  id: string
  at: string
  actor: string
  action: string
  record: string
  fromRevision: number
  toRevision: number
  reason: string
  session: string | null
  approval: string | null
}
export type Plant = {
  version: 1
  revision: number
  batches: Batch[]
  equipment: Equipment[]
  rooms: Room[]
  samples: Sample[]
  deviations: Deviation[]
  audit: Audit[]
}
export const out = (m: Measurement) => m.value < m.min || m.value > m.max
export const DEMO_DATE = '2024-10-20'
export const SIGNATURE_MEANINGS = {
  en: 'I approve this batch for release after reviewing the complete quality dossier.',
  'zh-CN': '我已审核完整质量档案，批准本批放行。',
}
export const SIGNATURE_MEANING = `${SIGNATURE_MEANINGS.en} / ${SIGNATURE_MEANINGS['zh-CN']}`
