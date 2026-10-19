import { Type } from '@sinclair/typebox'

export const text = Type.String({ maxLength: 12000 })
export const id = Type.String({ minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9_.:-]+$' })
export const revision = Type.Integer({ minimum: 0 })
const obj = <T extends Record<string, import('@sinclair/typebox').TSchema>>(fields: T) =>
  Type.Object(fields, { additionalProperties: false })
const list = <T extends import('@sinclair/typebox').TSchema>(schema: T) =>
  Type.Array(schema, { maxItems: 2048 })
const localized = obj({ en: text, 'zh-CN': text })
const measurement = obj({
  id,
  name: localized,
  value: Type.Number(),
  unit: text,
  min: Type.Number(),
  max: Type.Number(),
  at: text,
  source: text,
})
const signature = obj({ actor: text, at: text, meaning: localized })
const certificate = obj({
  id,
  batch: id,
  at: text,
  signer: text,
  meaning: text,
  approvalId: text,
  subjectRevision: text,
  dossierRevision: revision,
})
const step = obj({
  id,
  name: localized,
  equipment: id,
  room: id,
  at: text,
  cpp: list(measurement),
  operator: signature,
  verifier: Type.Union([signature, Type.Null()]),
})
const batch = obj({
  id,
  product: localized,
  form: Type.Union([Type.Literal('tablet'), Type.Literal('capsule')]),
  size: revision,
  date: text,
  status: Type.Union(['production', 'review', 'released'].map((x) => Type.Literal(x))),
  review: Type.Union(['pending', 'findings', 'accepted'].map((x) => Type.Literal(x))),
  steps: list(step),
  qc: list(measurement),
  deviationIds: list(id),
  retests: list(measurement),
  certificate: Type.Union([certificate, Type.Null()]),
})
const equipment = obj({
  id,
  name: localized,
  due: text,
  qualification: Type.Union([Type.Literal('qualified'), Type.Literal('suspended')]),
  calibrated: text,
  evidence: list(text),
})
const room = obj({
  id,
  grade: Type.Union(['A', 'B', 'C', 'D'].map((x) => Type.Literal(x))),
  name: localized,
  viableAlert: Type.Number(),
  viableAction: Type.Number(),
  particleAlert: Type.Number(),
  particleAction: Type.Number(),
})
const sample = obj({
  id,
  room: id,
  batch: id,
  at: text,
  viable: Type.Number(),
  particles: Type.Number(),
  disposition: Type.Union([Type.Literal('pending'), Type.Literal('assessed')]),
  evidence: text,
})
const deviation = obj({
  id,
  batch: id,
  severity: Type.Union(['minor', 'major', 'critical'].map((x) => Type.Literal(x))),
  title: localized,
  stage: Type.Union(['open', 'investigation', 'capa', 'effectiveness', 'closed'].map((x) => Type.Literal(x))),
  opened: text,
  cause: text,
  impact: list(id),
  why: list(text),
  actions: list(
    obj({ id, text: localized, owner: text, due: text, evidence: text, effective: Type.Boolean() }),
  ),
})
const audit = obj({
  id,
  at: text,
  actor: text,
  action: text,
  record: text,
  fromRevision: revision,
  toRevision: revision,
  reason: text,
  session: Type.Union([text, Type.Null()]),
  approval: Type.Union([text, Type.Null()]),
})
export const plantSchema = obj({
  version: Type.Literal(1),
  revision,
  batches: list(batch),
  equipment: list(equipment),
  rooms: list(room),
  samples: list(sample),
  deviations: list(deviation),
  audit: list(audit),
})
export const empty = obj({})
export const batchInput = obj({ batch: id })
export const changeInput = obj({
  action: Type.Union([Type.Literal('review'), Type.Literal('investigate'), Type.Literal('advance')]),
  batch: id,
  expectedRevision: revision,
  evidence: Type.Optional(Type.String({ minLength: 12, maxLength: 2000 })),
})
export const releaseInput = obj({
  batch: id,
  expectedRevision: revision,
  meaning: Type.String({ minLength: 1, maxLength: 500 }),
})
export const findingSchema = obj({ severity: text, code: text, text: localized, source: text })
export const dossierSchema = obj({
  batch: id,
  revision,
  asOf: text,
  ready: Type.Boolean(),
  rows: list(obj({ key: text, title: localized, pass: Type.Boolean() })),
  blockers: list(text),
  findings: list(findingSchema),
  evidence: obj({
    deviations: list(deviation),
    retests: list(measurement),
    equipment: list(equipment),
    em: list(sample),
    interpretation: localized,
  }),
  certificate: Type.Union([certificate, Type.Null()]),
})
export const investigationSchema = obj({
  batch: id,
  findings: list(findingSchema),
  em: list(sample),
  equipment: list(equipment),
  relatedBatches: list(id),
  hypothesis: localized,
})
export const snapshotSchema = obj({
  plant: plantSchema,
  dossiers: list(dossierSchema),
  kpi: obj({
    batches: revision,
    production: revision,
    awaiting: revision,
    released: revision,
    rft: revision,
    deviations: Type.Record(Type.String(), revision),
    overdue: revision,
    excursions: revision,
  }),
})
export const receiptSchema = obj({ revision, batch: id, dossier: dossierSchema })
export const plain = (schema: object) => JSON.parse(JSON.stringify(schema))
