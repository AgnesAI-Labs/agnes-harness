import { type Static, Type } from '@sinclair/typebox'

/** Exact action enum at NousResearch/hermes-agent@fb56a7e06dde62e9f645ff744c82cb47b60c469e. */
export const COMPUTER_USE_ACTIONS = [
  'capture',
  'click',
  'double_click',
  'right_click',
  'middle_click',
  'drag',
  'scroll',
  'type',
  'key',
  'set_value',
  'wait',
  'list_apps',
  'list_windows',
  'launch_app',
  'focus_app',
] as const

const choices = <T extends string>(values: readonly T[], description?: string) =>
  Type.Union(
    values.map((value) => Type.Literal(value)),
    description ? { description } : {},
  )
const optionalString = (description: string) => Type.Optional(Type.String({ description }))
const action = choices(
  COMPUTER_USE_ACTIONS,
  'Which action to perform. capture, wait, list_apps, and list_windows are read actions. Input, focus_app, and launch_app are never-replayed mutations and require approval unless the active policy already authorizes them. Use set_value for select/popup elements and sliders; it selects the matching option directly without opening the native menu.',
)
// Not Type.Tuple: its draft-07 `items: [...]` form is rejected outright by GLM and Agnes (HTTP 400).
const point = (description: string) => Type.Array(Type.Integer(), { minItems: 2, maxItems: 2, description })
const modifier = choices(['cmd', 'shift', 'option', 'alt', 'ctrl', 'fn', 'win', 'windows', 'super', 'meta'])

export const ComputerUseParams = Type.Object(
  {
    action,
    mode: Type.Optional(
      choices(
        ['som', 'vision', 'ax'],
        'Capture mode. som (default) is a screenshot with numbered interactable overlays plus the accessibility tree; vision is a plain screenshot; ax is the accessibility tree only with no image.',
      ),
    ),
    app: Type.Optional(
      Type.String({
        description:
          "Optional app name or stable app id. For launch_app, use one exact launchable app value from the latest list_apps result. For capture, omitted means the frontmost window; app='screen' and app='desktop' are the two explicit names for one composited full-screen image. For input, app is only a sticky-target mismatch guard and never retargets the action.",
      }),
    ),
    pid: Type.Optional(
      Type.Integer({
        description:
          "Optional exact process target for action='capture'; pair with window_id only from the latest list_windows result. Never reuse an earlier conversation turn's process target.",
      }),
    ),
    window_id: Type.Optional(
      Type.Integer({
        description:
          "Optional exact native window target for action='capture'; pair with pid only from the latest list_windows result. If the app is absent, use list_apps and launch_app when it is launchable.",
      }),
    ),
    element: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          'The zero-based element index returned by the latest capture(mode=som). Prefer this over raw coordinates.',
      }),
    ),
    coordinate: Type.Optional(
      point('Pixel coordinates [x,y] relative to the captured window, top-left origin.'),
    ),
    button: Type.Optional(choices(['left', 'right', 'middle'], 'Mouse button. Defaults to left.')),
    modifiers: Type.Optional(Type.Array(modifier, { description: 'Modifier keys held during the action.' })),
    from_element: Type.Optional(Type.Integer({ minimum: 0, description: 'Source element index for drag.' })),
    to_element: Type.Optional(Type.Integer({ minimum: 0, description: 'Target element index for drag.' })),
    from_coordinate: Type.Optional(
      point('Source [x,y] for drag; use only when no element index is available.'),
    ),
    to_coordinate: Type.Optional(
      point('Target [x,y] for drag; use only when no element index is available.'),
    ),
    direction: Type.Optional(choices(['up', 'down', 'left', 'right'], 'Scroll direction.')),
    amount: Type.Optional(Type.Integer({ description: 'Scroll wheel ticks, clamped to 1..50. Default 3.' })),
    value: optionalString(
      "For action='set_value', the option display label or slider/value string to set directly.",
    ),
    text: optionalString('Text to type using the current keyboard layout.'),
    keys: optionalString("Key combo such as 'cmd+s', 'ctrl+alt+t', 'return', 'escape', or 'tab'."),
    seconds: Type.Optional(Type.Number({ description: 'Seconds to wait, clamped to 0..30. Default 1.' })),
    raise_window: Type.Optional(
      Type.Boolean({
        description:
          'Only for focus_app. true brings the window to front and disrupts the user; default false preserves background co-work.',
      }),
    ),
    delivery_mode: Type.Optional(
      choices(
        ['background', 'foreground'],
        'Input delivery mode. background is the default and avoids stealing focus; foreground briefly fronts the exact target and needs its own approval. Follow the returned verdict before escalating.',
      ),
    ),
    bring_to_front: Type.Optional(
      Type.Boolean({
        description:
          "Only valid with delivery_mode='foreground'. Performs the separate persistent focus change before input and adds an independent approval scope. Default false.",
      }),
    ),
    capture_after: Type.Optional(
      Type.Boolean({
        description:
          'Compatibility hint requesting an exact-target capture after a successful state-changing action. Agnes production already observes every successful mutation and targeted wait. A follow-up failure is returned as a warning without changing or replaying the action outcome.',
      }),
    ),
  },
  { additionalProperties: false },
)

export type ComputerUseArgs = Static<typeof ComputerUseParams>

export const COMPUTER_USE_DESCRIPTION =
  "Drive the desktop through one reviewed Computer Use wrapper on macOS, Windows, and Linux. Discover missing applications with list_apps and start them with launch_app using the exact returned app value. For browser work, launch an exact browser row marked launchable so the Host creates a separate window; never operate the browser window hosting Agnes. Input is background-first: capture(mode='som'), prefer a fresh element index, and follow each structured verdict. Agnes production returns an exact-target capture after every successful mutation and targeted wait. Never repeat confirmed input; if verification warns or remains unverifiable, inspect fresh state instead of replaying the action."
