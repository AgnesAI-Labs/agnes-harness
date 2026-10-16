/** What a route's adapter has to tell a conversation entry point: its id and what it takes. */
type ServingAdapter = Readonly<{ id: string; capabilities: Readonly<{ payloadOnly?: boolean }> }>

/**
 * The declared routes whose adapter answers payload requests only. A route is served by the
 * registration whose id is the route's `api`, so that is the one asked, whatever wire API its models
 * name. A payload-only adapter takes a payload instead of messages: a conversation or a child agent
 * that selected one of these routes' models would fail at the adapter.
 */
export function payloadOnlyRoutes(
  adapters: readonly ServingAdapter[],
  routes: readonly Readonly<{ route: string; api: string }>[],
): ReadonlySet<string> {
  const payloadOnly = new Set(
    adapters.filter((adapter) => adapter.capabilities.payloadOnly === true).map((adapter) => adapter.id),
  )
  return new Set(routes.filter((route) => payloadOnly.has(route.api)).map((route) => route.route))
}
