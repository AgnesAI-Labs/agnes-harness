// The Web view of the reference slide outline; renderer.ts describes the view and its data. Everything
// in the data is rendered as text. JSX compiles against the host's React (a peer dependency), so the
// page keeps a single React.

type Phase = 'provisional' | 'finalized' | 'interrupted'

/** The parts of a view action this renderer reads. */
export interface Action {
  actionKey: string
  label: string
  kind: string
  availability: 'enabled' | 'disabled'
  requiredFeatures: string[]
  inputSchema?: { typeId: string; revision: number; digest: string }
}

/** The parts of a domain view this renderer reads. */
export interface View {
  viewId: string
  revision: number
  phase: Phase
  fallbackText: string
  data: unknown
  actions: Action[]
}

interface Context {
  commands: { submit(request: object): Promise<unknown> }
}

export interface Outline {
  title: string
  revision: number
  slides: { heading: string; points: string[] }[]
}

/** Appended to the title, so a draft or an interrupted outline never reads as a finished one. */
export const PHASE_MARKS: Record<Phase, string> = {
  provisional: ' (draft)',
  finalized: '',
  interrupted: ' (interrupted)',
}

// sha256 of the canonical JSON `{}`, the input every outline command takes.
const EMPTY_DIGEST = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const only = (value: object, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key))

/** The outline in view data and whether the data holds only fields this renderer knows. */
export function readOutline(data: unknown): { outline: Outline; known: boolean } | undefined {
  if (!record(data)) return undefined
  const { title, revision, slides } = data
  if (typeof title !== 'string' || !Number.isSafeInteger(revision) || !Array.isArray(slides)) return undefined
  let known = only(data, ['title', 'revision', 'slides'])
  const read: Outline['slides'] = []
  for (const slide of slides) {
    if (!record(slide)) return undefined
    const { heading, points } = slide
    if (typeof heading !== 'string' || !Array.isArray(points)) return undefined
    if (!points.every((point): point is string => typeof point === 'string')) return undefined
    known &&= only(slide, ['heading', 'points'])
    read.push({ heading, points })
  }
  return { outline: { title, revision: revision as number, slides: read }, known }
}

export function ReferenceOutline({ view, context }: { view: View; context: Context }) {
  const read = readOutline(view.data)
  if (read === undefined) return <p className="reference-outline">{view.fallbackText}</p>
  const { outline } = read
  // ponytail: a click is submitted once and its outcome shows up through the next view revision; a
  // refusal is not drawn. Add component state, as the generic card has, when retries are needed here.
  const submit = (action: Action) =>
    context.commands.submit({
      action: { viewId: view.viewId, actionKey: action.actionKey, viewRevision: view.revision },
      commandSchema: action.inputSchema,
      input: { kind: 'inline', schema: action.inputSchema, value: {}, digest: EMPTY_DIGEST, bytes: 2 },
      requestId: crypto.randomUUID(),
      expectedRevision: outline.revision,
    })
  return (
    <article className="reference-outline" data-phase={view.phase}>
      <h3>
        {outline.title}
        {PHASE_MARKS[view.phase]}
      </h3>
      <ol>
        {outline.slides.map((slide, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: slides carry no id; each revision replaces the list.
          <li key={index}>
            <h4>{slide.heading}</h4>
            <ul>
              {slide.points.map((point, at) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: points carry no id either.
                <li key={at}>{point}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {view.actions
        .filter((action) => action.kind === 'command')
        .map((action) => (
          <button
            key={action.actionKey}
            type="button"
            disabled={action.availability !== 'enabled'}
            onClick={() => void submit(action)}
          >
            {action.label}
          </button>
        ))}
    </article>
  )
}
