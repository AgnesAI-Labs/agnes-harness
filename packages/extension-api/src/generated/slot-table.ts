// generated from packages/protocol/schema/slots.json by tools/gen-tables.ts — do not edit
import type { SlotName, SlotSpec } from '../slots.js'

export const SLOT_TABLE = Object.freeze({
  "tool.card.inline": Object.freeze({ cardinality: "multi", order: 100, surfaces: Object.freeze(["tui","web","channel"] as const), failPolicy: "open" }),
  "sidebar.action": Object.freeze({ cardinality: "multi", order: 200, surfaces: Object.freeze(["tui","web"] as const), failPolicy: "open" }),
  "status.line": Object.freeze({ cardinality: "multi", order: 300, surfaces: Object.freeze(["tui","web","channel"] as const), failPolicy: "open" }),
  "notification": Object.freeze({ cardinality: "multi", order: 400, surfaces: Object.freeze(["web","channel"] as const), failPolicy: "open" }),
} as const satisfies Record<SlotName, SlotSpec>)
