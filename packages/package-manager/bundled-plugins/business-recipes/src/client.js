import { homeNavigation } from '@agnes/web-client'
import { Banner, Button, Disclosure, EmptyState, Field, Segmented, Select, Tag } from '@agnes/web-ui'
import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRecipeController, recipeInputs, recipeState } from './controller.js'
import { copy, errorText } from './locale.js'

function Recipe({ row, controller, busy, text, locale }) {
  const metadata = row.metadata.locales?.[locale] ?? row.metadata
  const fixtures = recipeInputs(row)
  const [fixture, setFixture] = useState(fixtures[0])
  const [language, setLanguage] = useState(locale)
  const state = recipeState(row)
  return h(
    'article',
    { className: 'agnes-settings-stack', 'aria-label': metadata.displayName },
    h('h2', {}, metadata.displayName),
    h(Tag, {}, text[state] ?? text.failed),
    h('p', {}, metadata.description),
    h('p', {}, text.requirements),
    fixtures.length === 0 && h(Banner, { tone: 'error' }, text.invalid),
    h(
      Field,
      { label: text.fixture },
      h(Select, {
        'aria-label': text.fixture,
        value: fixture,
        onChange: setFixture,
        disabled: busy,
        options: fixtures.map((value) => ({ value, label: value })),
      }),
    ),
    h(
      Field,
      { label: text.language },
      h(Select, {
        'aria-label': text.language,
        value: language,
        onChange: setLanguage,
        disabled: busy,
        options: [
          { value: 'en', label: 'English' },
          { value: 'zh-CN', label: '简体中文' },
        ],
      }),
    ),
    h(
      Button,
      {
        disabled: busy || (state === 'ready' && !fixture),
        onClick: () =>
          state === 'ready' ? controller.prepare(row, fixture, language) : controller.inspect(row),
      },
      state === 'ready' ? text.prepare : text.inspect,
    ),
  )
}

export function RecipesPage({ ctx, controller }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const locale = useSyncExternalStore(
    (listener) => ctx.locale.subscribe(listener),
    () => ctx.locale.locale,
  )
  const text = copy[locale] ?? copy.en
  const [readyOnly, setReadyOnly] = useState(false)
  const reviewRef = useRef(null)
  useEffect(() => {
    if (state.review || state.launch) reviewRef.current?.focus()
  }, [state.review, state.launch])
  useEffect(() => {
    void controller.refresh()
  }, [controller])
  const rows = state.rows.filter((row) => !readyOnly || recipeState(row) === 'ready')
  const review = state.review
  const launch = state.launch
  return h(
    'section',
    { className: 'agnes-settings-stack', 'aria-label': text.title, 'aria-busy': state.busy },
    h('h1', {}, text.title),
    h('p', {}, text.intro),
    h(Button, { onClick: controller.refresh, disabled: state.busy }, text.refresh),
    h(Segmented, {
      label: text.filter,
      value: readyOnly ? 'ready' : 'all',
      onChange: (value) => setReadyOnly(value === 'ready'),
      options: [
        { value: 'all', label: text.all },
        { value: 'ready', label: text.ready },
      ],
    }),
    state.error && h(Banner, { tone: 'error' }, errorText(state.error, text)),
    rows.length === 0 && h(EmptyState, { title: text.empty }),
    // biome-ignore lint/correctness/useJsxKeyInIterable: createElement receives key in its props object.
    ...rows.map((row) => h(Recipe, { key: row.id, row, controller, busy: state.busy, text, locale })),
    review &&
      h(
        'section',
        { 'aria-label': text.review, ref: reviewRef, tabIndex: -1 },
        h('h2', {}, text.review),
        h('p', {}, text.readOnly),
        h(
          Disclosure,
          { summary: `${review.row.id} · ${review.row.version}` },
          h('pre', {}, JSON.stringify(review.presentation, null, 2)),
        ),
        h('p', {}, review.integrity),
        h('p', {}, review.capabilityHash),
        h(Button, { appearance: 'primary', disabled: state.busy, onClick: controller.enable }, text.enable),
        h(Button, { disabled: state.busy, onClick: controller.dismiss }, text.cancel),
      ),
    launch &&
      h(
        'section',
        { 'aria-label': text.launch, ref: reviewRef, tabIndex: -1 },
        h('h2', {}, text.launch),
        h('pre', {}, JSON.stringify(launch.presentation, null, 2)),
        h(
          Button,
          {
            appearance: 'primary',
            disabled:
              state.busy || state.receipt?.state === 'completed' || state.receipt?.state === 'unknown',
            onClick: controller.start,
          },
          text.start,
        ),
        h(Button, { disabled: state.busy, onClick: controller.dismiss }, text.cancel),
      ),
    (launch || review) && h(Button, { disabled: state.busy, onClick: controller.read }, text.read),
    state.receipt &&
      h(
        Banner,
        { tone: state.receipt.state === 'completed' ? 'info' : 'warning' },
        state.receipt.state === 'completed'
          ? state.receipt.sessionId
            ? text.completed
            : text.enabled
          : state.receipt.state === 'running'
            ? text.running
            : state.receipt.state === 'unknown'
              ? text.unknownReceipt
              : text.failed,
        state.receipt.sessionId &&
          h(
            Button,
            {
              onClick: () => {
                homeNavigation.close()
                location.assign(`?session=${encodeURIComponent(state.receipt.sessionId)}`)
              },
            },
            text.session,
          ),
      ),
  )
}

export function apply(ctx) {
  const controller = createRecipeController(ctx.profile, ctx.availability)
  const stops = [() => controller.dispose()]
  try {
    stops.push(
      ctx.locale.register('business-recipes', {
        en: { 'recipes.title': copy.en.title },
        'zh-CN': { 'recipes.title': copy['zh-CN'].title },
      }),
    )
    stops.push(
      ctx.homeEntries.register({
        id: 'business-recipes',
        icon: 'book-open',
        titleKey: 'recipes.title',
        order: 110,
        component: () => h(RecipesPage, { ctx, controller }),
      }),
    )
  } catch (error) {
    for (const stop of stops.reverse()) stop()
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const stop of stops.reverse()) stop()
  }
}
