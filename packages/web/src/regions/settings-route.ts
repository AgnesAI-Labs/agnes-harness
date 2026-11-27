// A region route applies a host-chosen target, rather than asking the workbench to choose again.
// Track the actual event so an asynchronous open cannot lose its provenance or suppress user intent.
const regionRoutes = new WeakSet<Event>()

export function settingsRegionRoute(section: string): CustomEvent<string> {
  const event = new CustomEvent('agnes:settings-route', { detail: section, bubbles: true })
  regionRoutes.add(event)
  return event
}

export function isSettingsRegionRoute(event: Event): boolean {
  return regionRoutes.has(event)
}
