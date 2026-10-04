/** Package-local, compile-time identities; serialized values remain strings. */
declare const brand: unique symbol

export type Branded<Name extends string> = string & { readonly [brand]: Name }

/** Brand an identifier after its owning boundary has admitted it. */
export function brandString<T extends Branded<string>>(value: string | T): T {
  return value as T
}
