export type StateFailure = {
  code: 'invalid_input' | 'conflict' | 'incompatible' | 'internal'
  detailCode: string
  message: string
}

export class StateRefusal extends Error {
  readonly failure: StateFailure
  constructor(failure: StateFailure) {
    super(failure.message)
    this.name = 'StateRefusal'
    this.failure = failure
  }
}

export function refuse(code: StateFailure['code'], detailCode: string, message: string): never {
  throw new StateRefusal({ code, detailCode, message })
}

export function integrity(message: string): never {
  refuse('incompatible', 'integrity', message)
}
