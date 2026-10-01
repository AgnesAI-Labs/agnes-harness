export class AssemblyRefusal extends Error {
  readonly detail: Readonly<Record<string, string>>

  constructor(
    readonly code: string,
    message: string,
    detail: Readonly<Record<string, string>> = {},
  ) {
    super(message)
    this.name = 'AssemblyRefusal'
    this.detail = Object.freeze({ ...detail })
  }
}
