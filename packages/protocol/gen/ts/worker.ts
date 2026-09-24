// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'

export const WorkerSchema = Type.Module({
  "WorkerGeneration": Type.Integer({ minimum: 1, maximum: 9007199254740991 }),
  "RuntimeTargetIdentity": Type.Object({ "treeHash": Type.String({ pattern: "^[0-9a-f]{64}$" }), "resourceRevision": Type.String({ pattern: "^[0-9a-f]{64}$" }), "compositeRevision": Type.String({ pattern: "^[0-9a-f]{64}$" }) }, { additionalProperties: false }),
  "RuntimeTargetArtifact": Type.Object({ "encoding": Type.Literal('base64'), "canonicalBase64": Type.String({ minLength: 4, maxLength: 16776788, pattern: "^[A-Za-z0-9+/]+={0,2}$" }), "digest": Type.String({ pattern: "^sha256-[0-9a-f]{64}$" }), "identity": Type.Ref('RuntimeTargetIdentity') }, { additionalProperties: false }),
  "RuntimeStaleFrame": Type.Object({ "type": Type.Literal('runtime.stale'), "artifact": Type.Ref('RuntimeTargetArtifact') }, { additionalProperties: false }),
  "RuntimeConvergenceRow": Type.Object({ "id": Type.String({ minLength: 1 }), "state": Type.Union([Type.Literal('pending'), Type.Literal('loading'), Type.Literal('active'), Type.Literal('failed'), Type.Literal('disabled'), Type.Literal('waiting-drain')]), "reason": Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
  "RuntimeConvergenceReport": Type.Object({ "hash": Type.String({ pattern: "^[0-9a-f]{64}$" }), "ok": Type.Boolean(), "rows": Type.Array(Type.Ref('RuntimeConvergenceRow')) }, { additionalProperties: false }),
  "RuntimeBootReadyFrame": Type.Object({ "type": Type.Literal('runtime.boot_ready'), "workerKind": Type.Literal('session'), "workerKey": Type.Literal('@shared'), "generation": Type.Ref('WorkerGeneration'), "digest": Type.String({ pattern: "^sha256-[0-9a-f]{64}$" }), "identity": Type.Ref('RuntimeTargetIdentity'), "source": Type.Union([Type.Literal('lastGood'), Type.Literal('bootstrap')]) }, { additionalProperties: false }),
  "RuntimeConvergedFrame": Type.Object({ "type": Type.Literal('runtime.converged'), "workerKind": Type.Literal('session'), "workerKey": Type.Literal('@shared'), "generation": Type.Ref('WorkerGeneration'), "digest": Type.String({ pattern: "^sha256-[0-9a-f]{64}$" }), "identity": Type.Ref('RuntimeTargetIdentity'), "report": Type.Ref('RuntimeConvergenceReport') }, { additionalProperties: false }),
  "RuntimeApplyFailedFrame": Type.Object({ "type": Type.Literal('runtime.apply_failed'), "workerKind": Type.Literal('session'), "workerKey": Type.Literal('@shared'), "generation": Type.Ref('WorkerGeneration'), "digest": Type.String({ pattern: "^sha256-[0-9a-f]{64}$" }), "identity": Type.Ref('RuntimeTargetIdentity'), "phase": Type.String({ minLength: 1 }), "message": Type.String({ minLength: 1 }) }, { additionalProperties: false }),
})

export const WorkerGeneration = WorkerSchema.Import('WorkerGeneration')
export type WorkerGeneration = Static<typeof WorkerGeneration>
export const RuntimeTargetIdentity = WorkerSchema.Import('RuntimeTargetIdentity')
export type RuntimeTargetIdentity = Static<typeof RuntimeTargetIdentity>
export const RuntimeTargetArtifact = WorkerSchema.Import('RuntimeTargetArtifact')
export type RuntimeTargetArtifact = Static<typeof RuntimeTargetArtifact>
export const RuntimeStaleFrame = WorkerSchema.Import('RuntimeStaleFrame')
export type RuntimeStaleFrame = Static<typeof RuntimeStaleFrame>
export const RuntimeConvergenceRow = WorkerSchema.Import('RuntimeConvergenceRow')
export type RuntimeConvergenceRow = Static<typeof RuntimeConvergenceRow>
export const RuntimeConvergenceReport = WorkerSchema.Import('RuntimeConvergenceReport')
export type RuntimeConvergenceReport = Static<typeof RuntimeConvergenceReport>
export const RuntimeBootReadyFrame = WorkerSchema.Import('RuntimeBootReadyFrame')
export type RuntimeBootReadyFrame = Static<typeof RuntimeBootReadyFrame>
export const RuntimeConvergedFrame = WorkerSchema.Import('RuntimeConvergedFrame')
export type RuntimeConvergedFrame = Static<typeof RuntimeConvergedFrame>
export const RuntimeApplyFailedFrame = WorkerSchema.Import('RuntimeApplyFailedFrame')
export type RuntimeApplyFailedFrame = Static<typeof RuntimeApplyFailedFrame>
