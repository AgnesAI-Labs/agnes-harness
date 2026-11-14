// Adapted from dsh-superagent (MIT)
/** Reusable proactive-agent core: model, ports, engine and in-memory repositories. */

export {
  Engine,
  type EngineForExecutor,
  type EngineForMainSession,
  type EngineForPeople,
  type EngineForSettings,
  type EngineForSources,
  type EngineOptions,
  type Outcome,
  type ReceiveResult,
  type Reply,
  type ReplyRequest,
  type WorkerReport,
} from './engine.js'
export { USER_ERRORS, UserError, type UserErrorCode } from './errors.js'
export { key } from './ids.js'
export { MemoryRepositories } from './memory.js'
export * from './model.js'
export * from './ports.js'
export { REASONS, type Reason, type ReasonCode, reasonText, said } from './reasons.js'
export { canRetry, type TicketStage, ticketStage } from './stage.js'
