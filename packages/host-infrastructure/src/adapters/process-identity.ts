export type ProcessIdentity =
  | { state: 'alive'; startId: string }
  | { state: 'dead' }
  | { state: 'unknown'; reason: string }
