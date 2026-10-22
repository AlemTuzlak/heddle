// The app shell of heddle: it puts the panes together and routes the keys.
import type { BoxRenderable, SyntaxStyle } from '@opentui/core'
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react'
import { selectGoal, type Goal } from '@tanstack/ai-harness/plugins'
import type {
  Approval,
  SessionView,
  ViewCommand,
  ViewConfigEntry,
  ViewMessage,
  ViewPart,
} from '@tanstack/ai-harness/view'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MODELS } from '../harness'
import type { SyncState } from '../sandbox'
import type { ChangesState, ChangesWatch } from '../state/changes'
import { parseInput, suggest, type Input, type LocalAction } from '../state/commands'
import { buildAgentRows, buildRows, layoutLines, type Row } from '../state/timeline'
import { useView, useWatch, type ViewStore } from '../state/useView'
import { padWidth, widest } from '../utils'
import { ApprovalBar } from './ApprovalBar'
import { Changes } from './Changes'
import { Composer } from './Composer'
import { Header } from './Header'
import { Hints, type Hint } from './Hints'
import { isPlain, useKeyState } from './keys'
import { Palette } from './Palette'
import { SessionPicker, type SessionRow } from './SessionPicker'
import { Timeline } from './Timeline'
import { color } from './theme'

/**
 * An open session, as the app shows it. It has the same fields as
 * `OpenSession` in `src/session.ts`, so an `OpenSession` fits.
 */
export interface AppSession {
  threadId: string
  /** Where the tools run. */
  place: 'local' | 'docker'
  /** The tools root: the folder, or `/workspace` in a Docker sandbox. */
  root: string
  /** The live view of the session. A full `SessionView` fits. */
  view: Pick<SessionView, 'send' | 'runCommand' | 'cancel' | 'notice' | 'loadAgent'> & {
    store: ViewStore
  }
  /** The files that the session changed. */
  changes: ChangesWatch
  /** The copy back to the folder, in a Docker sandbox. */
  sync?: { state(): SyncState; onState(listener: (state: SyncState) => void): () => void }
  /** The provider of the current model when it has no API key, else `undefined`. */
  missingKey(): Promise<string | undefined>
  close(): Promise<void>
}

/** What the app needs from heddle to list, open, fork, and rename the sessions of the folder. */
export interface AppHost {
  listSessions(): Promise<Array<SessionRow>>
  /** Opens the session `threadId`, or a new session without it. */
  open(threadId?: string): Promise<AppSession>
  /** Copies the session `threadId`, and gives the id of the copy. */
  fork(threadId: string): Promise<string>
  rename(threadId: string, title: string): Promise<void>
}

/** The part that has the keys: a pane, or the input (the composer, or the approval bar while it waits). */
type Focus = 'timeline' | 'changes' | 'input'

/** Tab moves the focus in this order, then back to the start. */
const FOCUS_ORDER: ReadonlyArray<Focus> = ['timeline', 'changes', 'input']

/** The composer has the focus at the start. */
const START_FOCUS: Focus = 'input'

/** A pane. In a narrow terminal, one pane shows at a time. */
type PaneName = Exclude<Focus, 'input'>

/** The pane that shows first in a narrow terminal. */
const START_PANE: PaneName = 'timeline'

/** A box over the screen. */
type Overlay = 'sessions' | 'palette'

/** Under this many columns, one pane shows at a time. */
const NARROW_WIDTH = 100

/** The part of the width that the timeline pane takes when both panes show. */
const TIMELINE_SHARE = 0.45

/** The columns between the two panes. */
const PANE_GAP = 1

/** The columns of a pane that are not for its content: the two borders and the two padding cells. */
const PANE_FRAME_COLUMNS = 4

/** The rows of a pane that are not for its content: the two borders. */
const PANE_FRAME_ROWS = 2

/**
 * The rows that are not for the panes, when the composer has one line: the
 * header (1), the composer (3), and the hints (1).
 */
const CHROME_ROWS = 5

/** The rows of the approval bar with one line. */
const BAR_ROWS = 3

/** Two ctrl+c in this time quit. */
const QUIT_MS = 1000

/** The text in the empty composer. */
const PLACEHOLDER = 'Ask heddle, or type / for a command'

/** The plugin settings that the header shows. */
const MODEL_SETTING = { owner: 'tanstack/model-picker', key: 'model' }
const AGENT_SETTING = { owner: 'tanstack/agents', key: 'agent' }

/** The keys that work in each part. */
const MOVE_HINTS: ReadonlyArray<Hint> = [
  { key: 'tab', label: 'next pane' },
  { key: 'ctrl+o', label: 'sessions' },
  { key: 'ctrl+k', label: 'commands' },
]

/** The app does not need the selected row of a timeline: the timeline keeps it. */
function ignoreSelect() {}

/** The part after `focus` in the tab order. */
function nextFocus(focus: Focus) {
  return FOCUS_ORDER[(FOCUS_ORDER.indexOf(focus) + 1) % FOCUS_ORDER.length]
}

/** The text value of the plugin setting `key` of `owner`. */
function settingText(config: ReadonlyArray<ViewConfigEntry>, setting: { owner: string; key: string }) {
  const entry = config.find((item) => item.owner === setting.owner && item.key === setting.key)
  return typeof entry?.value === 'string' ? entry.value : undefined
}

/** The goal chip of the header: a goal that runs or waits. A goal that is met or stopped does not show. */
function goalChipOf(goal: Goal | null) {
  const isOngoing = goal !== null && (goal.status === 'active' || goal.status === 'paused')
  return isOngoing ? { text: goal.text, round: goal.round } : undefined
}

/** The `+N −N` of each tool call: the sum of the lines of its file changes, by tool call id. */
function countsByToolCall(state: ChangesState) {
  const counts = new Map<string, { additions: number; deletions: number }>()
  const patches = state.files.flatMap((file) => file.patches)
  for (const patch of patches) {
    const id = patch.toolCallId
    if (id === undefined) continue
    const sum = counts.get(id) ?? { additions: 0, deletions: 0 }
    counts.set(id, {
      additions: sum.additions + patch.additions,
      deletions: sum.deletions + patch.deletions,
    })
  }
  return counts
}

/** The agent part `id` in the messages, also in the parts of other agents. */
function findAgent(messages: ReadonlyArray<ViewMessage>, id: string) {
  const parts: Array<ViewPart> = messages.flatMap((message) =>
    message.role === 'assistant' ? message.parts : [],
  )
  for (let part = parts.pop(); part !== undefined; part = parts.pop()) {
    if (part.type !== 'agent') continue
    if (part.id === id) return part
    parts.push(...part.parts)
  }
  return undefined
}

/** The row for a send without a key, for example `No API key for anthropic. Type /connect anthropic, or set ANTHROPIC_API_KEY.` */
function missingKeyText(provider: string) {
  const env = MODELS.find((choice) => choice.provider === provider)?.env
  const connect = `No API key for ${provider}. Type /connect ${provider}`
  return env === undefined ? `${connect}.` : `${connect}, or set ${env}.`
}

/** The text of `/help`: each command, and what it does. */
function helpText(commands: ReadonlyArray<ViewCommand>) {
  const rows = suggest('/', commands)
  const width = widest(rows.map((row) => row.label))
  const lines = rows.map((row) => `${padWidth(row.label, width)}  ${row.detail}`)
  return ['Commands:', ...lines].join('\n')
}

/** The text of an error. */
function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `approval`, with actions that also call `onAnswer`. The view keeps an
 * answered approval until each approval of the turn has an answer, so the
 * app keeps the answered ids, and gives the bar the next one.
 */
function withAnswerMark(approval: Approval, onAnswer: (id: string) => void) {
  const marked: Approval = {
    ...approval,
    approve: (options) => {
      approval.approve(options)
      onAnswer(approval.id)
    },
    reject: (options) => {
      approval.reject(options)
      onAnswer(approval.id)
    },
  }
  return marked
}

/** The keys of the part that has the focus, for the hint row. */
function hintsFor({ focus, isAnswering, isAgentOpen, isRunning, isQuitting }: {
  focus: Focus
  /** True while the approval bar waits for an answer. */
  isAnswering: boolean
  /** True while the right pane shows the transcript of an agent. */
  isAgentOpen: boolean
  isRunning: boolean
  /** True after the first ctrl+c. */
  isQuitting: boolean
}) {
  const quit: Array<Hint> = isQuitting ? [{ key: 'ctrl+c', label: 'again to quit' }] : []
  const escape: Array<Hint> = isAgentOpen
    ? [{ key: 'esc', label: 'back' }]
    : isRunning
      ? [{ key: 'esc', label: 'stop' }]
      : []
  const rowKeys: Array<Hint> = [
    { key: '↑↓', label: 'select' },
    { key: 'enter', label: 'open' },
  ]
  const fileKeys: Array<Hint> = [
    { key: '↑↓', label: 'file' },
    { key: '[ ]', label: 'patch' },
    { key: 'f', label: 'follow' },
  ]
  switch (focus) {
    case 'input':
      // The approval bar shows its own keys.
      if (isAnswering) return [...quit, ...MOVE_HINTS]
      return [
        ...quit,
        { key: 'enter', label: 'send' },
        ...escape,
        ...MOVE_HINTS,
        { key: '/', label: 'command' },
      ]
    case 'timeline':
      return [...quit, ...rowKeys, ...escape, ...MOVE_HINTS]
    case 'changes':
      return [...quit, ...(isAgentOpen ? rowKeys : fileKeys), ...escape, ...MOVE_HINTS]
  }
}

/**
 * A pane: a rounded frame with its title in the top border. The frame and
 * the title are indigo while the pane has the focus.
 *
 * @param alignBottom Keep the end of the content in view when the pane is
 *   shorter than the content: for a timeline, whose newest lines are at the end.
 */
function Pane({ title, focused, shown, width, alignBottom, children }: {
  title: string
  focused: boolean
  shown: boolean
  width: number
  alignBottom: boolean
  children: ReactNode
}) {
  return (
    <box
      visible={shown}
      width={width}
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={focused ? color.indigoDim : color.line}
      title={` ${title} `}
      titleColor={focused ? color.indigo : color.muted}
      paddingX={1}
      flexDirection="column"
      justifyContent={alignBottom ? 'flex-end' : 'flex-start'}
      overflow="hidden"
    >
      {children}
    </box>
  )
}

/**
 * The heddle screen for one open session. From the top: the header, the
 * session timeline (about 45% of the width) and the changes pane, the
 * approval bar while an approval or a question waits, the composer, and the
 * key hints. Under 100 columns, one pane shows at a time.
 *
 * Keys:
 *
 * - The composer has the focus at the start. Tab moves the focus from the
 *   timeline to the changes to the composer. In a narrow terminal, the pane
 *   that shows follows the focus.
 * - While an approval or a question waits, the approval bar has the focus
 *   in place of the composer, and takes `y`, `a`, and `n`.
 * - ctrl+o opens the session picker, and ctrl+k the command palette.
 * - Enter on an agent row shows the transcript of that agent in the right
 *   pane. Esc goes back to the changes.
 * - Esc while a turn runs stops it.
 * - ctrl+c twice in 1 second calls `onQuit`.
 *
 * The composer text goes to `parseInput`. A send first checks the API key.
 * When the key is missing, it shows `No API key for <provider>. Type
 * /connect <provider>, or set <ENV>.` and does not send.
 *
 * To switch sessions (open, new, fork), the app opens the new session with
 * `host`, shows it, then closes the old one. It does not close the session
 * that shows when the user quits: the owner of `host` does that.
 *
 * Render it in a renderer that does not exit on ctrl+c, because the app
 * handles ctrl+c itself.
 *
 * @param host Lists, opens, forks, and renames the sessions of the folder.
 * @param session The session to show first.
 * @param syntaxStyle The colors of the code in the diffs, from
 *   `createSyntaxStyle(renderer)`. Destroy it after the app is unmounted.
 * @param startWith `'sessions'` opens the session picker at the start.
 * @param onQuit Called once the user quits: ctrl+c twice, `/quit`, or `/exit`.
 * @example
 * const renderer = await createCliRenderer({ exitOnCtrlC: false, screenMode: 'alternate-screen' })
 * const syntaxStyle = createSyntaxStyle(renderer)
 * createRoot(renderer).render(
 *   <App host={heddle} session={session} syntaxStyle={syntaxStyle} onQuit={quit} />,
 * )
 */
export function App({ host, session: first, syntaxStyle, startWith, onQuit }: {
  host: AppHost
  session: AppSession
  syntaxStyle: SyntaxStyle
  startWith?: 'sessions'
  onQuit(): void
}) {
  const renderer = useRenderer()
  const terminal = useTerminalDimensions()
  const current = useKeyState(first)
  const session = current.value
  const { view } = session
  const focus = useKeyState(START_FOCUS)
  /** The pane that shows in a narrow terminal: the pane that had the focus last. */
  const [narrowPane, setNarrowPane] = useState(START_PANE)
  const overlay = useKeyState<Overlay | undefined>(startWith)
  /** The agent whose transcript the right pane shows. */
  const agentId = useKeyState<string | undefined>(undefined)
  /** The ids of the approvals that the user answered. */
  const answered = useKeyState<ReadonlySet<string>>(new Set())
  /** The time of the first ctrl+c, while a second one quits. */
  const quitAt = useKeyState<number | undefined>(undefined)
  const [sessions, setSessions] = useState<ReadonlyArray<SessionRow>>([])
  const [missingKey, setMissingKey] = useState<string>()
  /** The rows that the composer and the approval bar take beyond one line. */
  const [extraRows, setExtraRows] = useState(0)
  const panesBox = useRef<BoxRenderable>(null)

  const messages = useView(view, (state) => state.messages)
  const status = useView(view, (state) => state.status)
  const approvals = useView(view, (state) => state.approvals)
  const questions = useView(view, (state) => state.questions)
  const commands = useView(view, (state) => state.commands)
  const config = useView(view, (state) => state.config)
  const goal = useView(view, selectGoal)
  const cost = useView(view, (state) => state.usage?.total.cost)
  const changes = useWatch(session.changes)
  const syncWatch = useMemo(
    () => ({
      get: () => session.sync?.state(),
      subscribe: (listener: () => void) => session.sync?.onState(listener) ?? (() => {}),
    }),
    [session],
  )
  const sync = useWatch(syncWatch)

  const model = settingText(config, MODEL_SETTING) ?? ''
  const counts = useMemo(() => countsByToolCall(changes), [changes])
  const rowOptions = useMemo(
    () => ({ model, root: session.root, counts }),
    [model, session.root, counts],
  )
  const rows = useMemo(() => buildRows(messages, rowOptions), [messages, rowOptions])
  const agent = agentId.value === undefined ? undefined : findAgent(messages, agentId.value)
  const agentRows = useMemo(
    () => (agent === undefined ? [] : buildAgentRows(agent, rowOptions)),
    [agent, rowOptions],
  )

  const approval = approvals.find((item) => !answered.value.has(item.id))
  const question = questions.at(0)
  const waitingId = approval?.id ?? question?.id
  const isWaiting = waitingId !== undefined
  const isOverlay = overlay.value !== undefined
  const isRunning = status === 'running'

  // The sizes. The panes take the rows that the rest leaves. The composer
  // and the approval bar can take more than one line: `extraRows` has those
  // rows, from the size of the panes after the layout.
  const isNarrow = terminal.width < NARROW_WIDTH
  const timelineWidth = isNarrow ? terminal.width : Math.round(terminal.width * TIMELINE_SHARE)
  const rightWidth = isNarrow ? terminal.width : terminal.width - timelineWidth - PANE_GAP
  /** The rows of the panes in a terminal `height` rows high, when the composer and the bar have one line. */
  const panesRowsFor = (height: number) => height - CHROME_ROWS - (isWaiting ? BAR_ROWS : 0)
  const paneRows = Math.max(PANE_FRAME_ROWS + 1, panesRowsFor(terminal.height) - extraRows)
  const innerRows = paneRows - PANE_FRAME_ROWS
  const timelineInner = Math.max(1, timelineWidth - PANE_FRAME_COLUMNS)
  const rightInner = Math.max(1, rightWidth - PANE_FRAME_COLUMNS)
  const lines = useMemo(() => layoutLines(rows, timelineInner), [rows, timelineInner])
  const agentLines = useMemo(() => layoutLines(agentRows, rightInner), [agentRows, rightInner])
  const isTimelineShown = !isNarrow || narrowPane === 'timeline'
  const isRightShown = !isNarrow || narrowPane === 'changes'

  /** Shows a problem as a row of the timeline. */
  const report = (error: unknown) => {
    current.now().view.notice({ text: messageOf(error) })
  }

  const markAnswered = (id: string) => {
    answered.set(new Set([...answered.now(), id]))
  }

  const refreshSessions = () => {
    host.listSessions().then(setSessions, report)
  }

  const moveFocus = (next: Focus) => {
    focus.set(next)
    if (next !== 'input') setNarrowPane(next)
  }

  const openOverlay = (next: Overlay) => {
    overlay.set(next)
    if (next === 'sessions') refreshSessions()
  }

  const toggleOverlay = (next: Overlay) => {
    if (overlay.now() === next) overlay.set(undefined)
    else openOverlay(next)
  }

  /** Shows the transcript of the agent `id` in the right pane, and loads it when it is saved. */
  const openAgent = (id: string) => {
    agentId.set(id)
    moveFocus('changes')
    current.now().view.loadAgent({ id }).catch(report)
  }

  /** Enter on a row of `list`: an agent row opens the transcript of the agent. */
  const openRowIn = (list: ReadonlyArray<Row>) => (rowId: string) => {
    const id = list.find((row) => row.id === rowId)?.agentId
    if (id !== undefined) openAgent(id)
  }

  /** Opens a session with `open`, shows it, then closes the session that showed before. */
  const switchTo = async (open: () => Promise<AppSession>) => {
    const previous = current.now()
    const next = await open()
    current.set(next)
    agentId.set(undefined)
    answered.set(new Set())
    await previous.close()
  }

  const startSwitch = (open: () => Promise<AppSession>) => {
    switchTo(open).catch(report)
  }

  const runLocal = (action: LocalAction) => {
    switch (action) {
      case 'sessions':
        openOverlay('sessions')
        return
      case 'new':
        startSwitch(() => host.open())
        return
      case 'quit':
        onQuit()
        return
      case 'help':
        current.now().view.notice({ text: helpText(commands) })
        return
    }
  }

  /** Does what one line of the composer or one palette command asks. */
  const run = async (input: Input) => {
    const target = current.now()
    switch (input.kind) {
      case 'send': {
        const provider = await target.missingKey()
        setMissingKey(provider)
        if (provider === undefined) {
          await target.view.send(input.text)
          return
        }
        target.view.notice({ text: missingKeyText(provider) })
        return
      }
      case 'command':
        await target.view.runCommand({ name: input.name, input: input.input })
        return
      case 'local':
        runLocal(input.action)
        return
      case 'error':
        target.view.notice({ text: input.message })
        return
    }
  }

  const submit = (text: string) => {
    run(parseInput(text, commands)).catch(report)
  }

  const pressQuit = () => {
    const now = renderer.clock.now()
    const firstPress = quitAt.now()
    const isSecond = firstPress !== undefined && now - firstPress <= QUIT_MS
    if (isSecond) {
      onQuit()
      return
    }
    quitAt.set(now)
  }

  useKeyboard((key) => {
    // ctrl+c, ctrl+o, and ctrl+k work everywhere, also over an overlay.
    const isControl = key.ctrl && !key.meta && !key.shift
    if (isControl) {
      switch (key.name) {
        case 'c':
          key.preventDefault()
          pressQuit()
          return
        case 'o':
          key.preventDefault()
          toggleOverlay('sessions')
          return
        case 'k':
          key.preventDefault()
          toggleOverlay('palette')
          return
      }
    }
    // A key that the composer or a pane used is not for the app. An open
    // overlay takes all the other keys.
    const isTaken = key.defaultPrevented || overlay.now() !== undefined
    if (isTaken || !isPlain(key) || key.shift) return
    switch (key.name) {
      case 'tab':
        key.preventDefault()
        moveFocus(nextFocus(focus.now()))
        return
      case 'escape': {
        // While it has the focus, the approval bar takes esc: it closes its reason input.
        const isBarFocused = isWaiting && focus.now() === 'input'
        if (isBarFocused) return
        if (agentId.now() !== undefined) {
          key.preventDefault()
          agentId.set(undefined)
          return
        }
        if (!isRunning) return
        key.preventDefault()
        current.now().view.cancel().catch(report)
        return
      }
    }
  })

  // The title of the session is in the session list. The title plugin
  // writes it during the first turn, so the list loads again when the
  // status changes.
  useEffect(() => {
    refreshSessions()
  }, [host, session, status])

  // A command can save or remove a key, and its result comes as a new
  // message. So the app checks the key at the start and after each new message.
  useEffect(() => {
    let isCurrent = true
    session.missingKey().then((provider) => {
      if (isCurrent) setMissingKey(provider)
    }, report)
    return () => {
      isCurrent = false
    }
  }, [session, messages.length])

  // A new approval or question takes the focus, so that it gets an answer.
  useEffect(() => {
    if (waitingId !== undefined) focus.set('input')
  }, [waitingId])

  // The first ctrl+c counts for `QUIT_MS`.
  useEffect(() => {
    if (quitAt.value === undefined) return
    const timer = renderer.clock.setTimeout(() => quitAt.set(undefined), QUIT_MS)
    return () => renderer.clock.clearTimeout(timer)
  }, [quitAt.value, renderer])

  const onPanesSize = () => {
    const box = panesBox.current
    if (box === null) return
    // The renderer has the terminal size of this layout. The React state can
    // get a new size one render later.
    const extra = panesRowsFor(renderer.height) - box.height
    if (extra !== extraRows) setExtraRows(extra)
  }

  const isFocusable = !isOverlay
  const isAgentOpen = agent !== undefined
  const hints = hintsFor({
    focus: focus.value,
    isAnswering: isWaiting,
    isAgentOpen,
    isRunning,
    isQuitting: quitAt.value !== undefined,
  })
  const paletteItems = () =>
    suggest('/', commands).map((row) => ({
      label: row.label,
      detail: row.detail,
      run: () => submit(row.insert),
    }))
  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={color.loom}>
      <Header
        title={sessions.find((row) => row.id === session.threadId)?.title}
        goal={goalChipOf(goal)}
        model={model}
        agent={settingText(config, AGENT_SETTING)}
        place={session.place}
        sync={sync}
        cost={cost}
        missingKey={missingKey}
      />
      <box
        ref={panesBox}
        flexDirection="row"
        flexGrow={1}
        flexBasis={0}
        columnGap={PANE_GAP}
        overflow="hidden"
        onSizeChange={onPanesSize}
      >
        <Pane
          title="session"
          focused={isFocusable && focus.value === 'timeline'}
          shown={isTimelineShown}
          width={timelineWidth}
          alignBottom
        >
          <Timeline
            key={session.threadId}
            lines={lines}
            width={timelineInner}
            height={innerRows}
            focused={isFocusable && focus.value === 'timeline'}
            live={isTimelineShown && status !== 'idle'}
            onSelect={ignoreSelect}
            onOpen={openRowIn(rows)}
          />
        </Pane>
        <Pane
          title={agent?.name ?? 'changes'}
          focused={isFocusable && focus.value === 'changes'}
          shown={isRightShown}
          width={rightWidth}
          alignBottom={isAgentOpen}
        >
          <box visible={!isAgentOpen} flexShrink={0}>
            <Changes
              key={session.threadId}
              state={changes}
              width={rightInner}
              height={innerRows}
              focused={isFocusable && focus.value === 'changes' && !isAgentOpen}
              syntaxStyle={syntaxStyle}
            />
          </box>
          {agent === undefined ? null : (
            <Timeline
              key={agent.id}
              lines={agentLines}
              width={rightInner}
              height={innerRows}
              focused={isFocusable && focus.value === 'changes'}
              live={isRightShown && agent.status === 'running'}
              onSelect={ignoreSelect}
              onOpen={openRowIn(agentRows)}
            />
          )}
        </Pane>
      </box>
      {isWaiting ? (
        <ApprovalBar
          approval={approval && withAnswerMark(approval, markAnswered)}
          question={question}
          focused={isFocusable && focus.value === 'input'}
        />
      ) : null}
      <Composer
        commands={commands}
        focused={isFocusable && !isWaiting && focus.value === 'input'}
        placeholder={PLACEHOLDER}
        onSubmit={submit}
      />
      <Hints hints={hints} />
      {overlay.value === 'sessions' ? (
        <SessionPicker
          sessions={sessions}
          currentId={session.threadId}
          onOpen={(id) => {
            if (id !== current.now().threadId) startSwitch(() => host.open(id))
          }}
          onNew={() => startSwitch(() => host.open())}
          onFork={(id) => startSwitch(async () => host.open(await host.fork(id)))}
          onRename={(id, title) => {
            host.rename(id, title).then(refreshSessions, report)
          }}
          onClose={() => overlay.set(undefined)}
        />
      ) : null}
      {overlay.value === 'palette' ? (
        <Palette items={paletteItems()} onClose={() => overlay.set(undefined)} />
      ) : null}
    </box>
  )
}
