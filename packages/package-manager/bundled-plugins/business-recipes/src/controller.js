/** A presentation controller over the existing owner-bound example facade. No admin transport. */
export function recipeState(row) {
  if (row.installation === 'not-installed') return 'not-installed'
  if (row.trusted !== true) return row.trusted === false ? 'untrusted' : 'review-required'
  if (row.installation === 'enabled') return 'ready'
  return row.installation
}

export function launchChoice(row, fixture, language) {
  if (!['en', 'zh-CN'].includes(language)) throw new Error('INVALID_REQUEST')
  const launch = row.metadata.launches?.find((item) => item.id === `${fixture}-${language.toLowerCase()}`)
  if (launch?.kind !== 'business-agent') throw new Error('INVALID_REQUEST')
  // Never interpolate form strings into prompts, paths, bundles or model configuration.
  let input
  try {
    input = JSON.parse(launch.prompt)
  } catch {
    throw new Error('INVALID_REQUEST')
  }
  if (!input || typeof input !== 'object' || input.fixture !== fixture || input.language !== language)
    throw new Error('INVALID_REQUEST')
  return launch
}

export function recipeInputs(row) {
  const fixtures = new Set()
  for (const launch of row.metadata.launches ?? []) {
    try {
      const input = JSON.parse(launch.prompt)
      if (typeof input?.fixture === 'string' && input.fixture.length <= 128) {
        launchChoice(row, input.fixture, input.language)
        fixtures.add(input.fixture)
      }
    } catch {
      /* Malformed metadata is unavailable, never executable form input. */
    }
  }
  return [...fixtures]
}

export function createRecipeController(profile, availability, uuid = () => crypto.randomUUID()) {
  let snapshot = {
    rows: [],
    busy: false,
    review: undefined,
    launch: undefined,
    receipt: undefined,
    error: undefined,
  }
  let live = true
  const listeners = new Set()
  const publish = (patch) => {
    if (!live) return
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const active = () => {
    if (!live || availability.getSnapshot()?.availability !== 'active') throw new Error('CAPABILITY_DENIED')
  }
  async function action(run) {
    if (snapshot.busy) return
    publish({ busy: true, error: undefined })
    try {
      active()
      return await run()
    } catch (error) {
      publish({ error: error instanceof Error ? error.message : 'OUTCOME_UNKNOWN' })
    } finally {
      publish({ busy: false })
    }
  }
  async function refresh() {
    active()
    const rows = await profile.examples.list()
    active()
    const curated = rows.filter((row) =>
      [
        '@agnes-recipe/support-intake',
        '@agnes-recipe/invoice-review',
        '@agnes-recipe/meeting-brief',
      ].includes(row.id),
    )
    const pending = snapshot.launch
    const current = pending && curated.find((row) => row.id === pending.row.id)
    const invalid =
      pending && (!current || recipeState(current) !== 'ready' || current.integrity !== pending.row.integrity)
    publish({ rows: curated, ...(invalid ? { launch: undefined } : {}) })
  }
  const off = availability.subscribe(() => {
    if (availability.getSnapshot()?.availability !== 'active')
      publish({
        rows: [],
        review: undefined,
        launch: undefined,
        receipt: undefined,
        error: 'CAPABILITY_DENIED',
      })
  })
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh: () => action(refresh),
    inspect: (row) =>
      action(async () => {
        const review = await profile.examples.inspect(row.id)
        active()
        publish({ review: { row, ...review, operationId: uuid() }, launch: undefined, receipt: undefined })
      }),
    enable: () =>
      action(async () => {
        const review = snapshot.review
        if (!review) throw new Error('E_PACKAGE_PREVIEW_STALE')
        // Retain the same review and operation on a lost reply. Never silently install on preview.
        await profile.examples.enable(review.reviewId, review.operationId)
        active()
        publish({ review: undefined })
        await refresh()
      }),
    prepare: (row, fixture, language) =>
      action(async () => {
        if (recipeState(row) !== 'ready') throw new Error('E_PACKAGE_STATE')
        const choice = launchChoice(row, fixture, language)
        const prepared = await profile.launch.prepare(row.id, choice.id)
        active()
        publish({ launch: { row, ...prepared, operationId: uuid() }, review: undefined, receipt: undefined })
      }),
    start: () =>
      action(async () => {
        const launch = snapshot.launch
        if (!launch) throw new Error('E_PACKAGE_PREVIEW_STALE')
        const result = await profile.launch.start(launch.launchTicket, launch.operationId)
        active()
        publish({ receipt: { ...result, state: 'completed' } })
      }),
    read: () =>
      action(async () => {
        const operation = snapshot.launch ?? snapshot.review
        if (!operation) throw new Error('E_PACKAGE_STATE')
        publish({ receipt: await profile.examples.read(operation.operationId) })
        await refresh()
      }),
    dismiss() {
      if (!snapshot.busy)
        publish({ review: undefined, launch: undefined, receipt: undefined, error: undefined })
    },
    dispose() {
      live = false
      off()
      listeners.clear()
      snapshot = { rows: [], busy: false }
    },
  }
}
