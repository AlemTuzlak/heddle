import { useKeyboard } from '@opentui/react'
import type { Hint } from './Hints'
import { cutEnd, cutStart, padWidth, widest } from '../utils'
import { isEnter, typedText, useKeyState, useLine } from './keys'
import { filterByText, ListRow, Overlay, useOverlayLayout, windowStart } from './Palette'
import { color, glyph } from './theme'

/** One session of the folder, as the session picker shows it. */
export interface SessionRow {
  /** The id of the session. The picker gives it to the callbacks. */
  id: string
  /** The title of the session. The search reads it. */
  title: string
  /** The state of the session: `live`, `needs-you` (it waits for an answer), or `done`. */
  status: 'live' | 'needs-you' | 'done'
  /** Where the tools of the session run. */
  place: 'local' | 'docker'
  /** The time of the last change, in milliseconds, as from `Date.now()`. */
  updatedAt: number
  /** The cost of the session, in US dollars. */
  cost?: number
}

/** The glyph, the word, and the color of each status. */
const STATUS = {
  live: { glyph: glyph.dot, word: 'live', fg: color.indigo },
  'needs-you': { glyph: '◌', word: 'needs you', fg: color.weld },
  done: { glyph: '✓', word: 'done', fg: color.muted },
} satisfies Record<SessionRow['status'], { glyph: string; word: string; fg: string }>

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The units of the time ago, from the largest to the smallest. */
const TIME_UNITS = [
  ['year', 365 * DAY],
  ['month', 30 * DAY],
  ['week', 7 * DAY],
  ['day', DAY],
  ['hour', HOUR],
  ['minute', MINUTE],
] as const satisfies ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]>

const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

/** The cells in front of a title: the selection bar, the status glyph, and a space. */
const LEAD = 3

/** The cells between two columns. */
const GAP = 2

/**
 * A title keeps at least this many cells. When a row is too narrow for that,
 * the picker hides the status words, and then the places.
 */
const MIN_TITLE = 16

/** The mark after the title of the session that is open now. */
const CURRENT_MARK = ' (current)'

/** The text when the folder has no sessions. */
const NO_SESSIONS = 'No sessions in this folder yet. Press n to start one.'

/** The text when no title has the search text. */
const NO_MATCH = 'No session matches the search.'

/** The keys under the sessions. */
const LIST_HINTS: ReadonlyArray<Hint> = [
  { key: '↑↓', label: 'move' },
  { key: 'enter', label: 'resume' },
  { key: 'f', label: 'fork' },
  { key: 'r', label: 'rename' },
  { key: 'n', label: 'new' },
  { key: 'esc', label: 'close' },
]

/** The keys while the user types a new title. */
const RENAME_HINTS: ReadonlyArray<Hint> = [
  { key: 'enter', label: 'save' },
  { key: 'esc', label: 'cancel' },
]

/** `text` on one line: each run of spaces, line breaks, and control codes becomes one space. */
function oneLine(text: string) {
  return text.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, ' ').trim()
}

/** The title of a session on one line, as the row shows it and the search reads it. */
function titleOf(session: SessionRow) {
  return oneLine(session.title)
}

/** How long ago `updatedAt` was, for example `2 hours ago` or `yesterday`. Less than a minute is `now`. */
function timeAgo(updatedAt: number, now: number) {
  const elapsed = now - updatedAt
  const unit = TIME_UNITS.find(([, size]) => elapsed >= size)
  // A time after `now` is also `now`.
  if (unit === undefined) return 'now'
  const [name, size] = unit
  return relativeTime.format(-Math.floor(elapsed / size), name)
}

/** The texts of the columns after the title. */
function cellsOf(session: SessionRow, now: number) {
  return {
    status: STATUS[session.status].word,
    place: session.place,
    time: timeAgo(session.updatedAt, now),
    cost: session.cost === undefined ? '' : `$${session.cost.toFixed(2)}`,
  }
}

type Cells = ReturnType<typeof cellsOf>

/**
 * The cells of each column in a row of `inner` cells. A column fits its
 * widest text, and the title gets the rest. A column of 0 cells does not
 * show: a cost when no session has one, and in a narrow row, the status
 * words and then the places.
 */
function columnsFor(cells: ReadonlyArray<Cells>, inner: number) {
  const time = widest(cells.map((cell) => cell.time))
  const cost = widest(cells.map((cell) => cell.cost))
  const place = widest(cells.map((cell) => cell.place))
  const status = widest(cells.map((cell) => cell.status))
  const column = (width: number) => (width === 0 ? 0 : GAP + width)
  const base = LEAD + column(time) + column(cost)
  const withPlace = base + column(place)
  const withStatus = withPlace + column(status)
  if (inner - withStatus >= MIN_TITLE) return { title: inner - withStatus, status, place, time, cost }
  if (inner - withPlace >= MIN_TITLE) return { title: inner - withPlace, status: 0, place, time, cost }
  return { title: Math.max(1, inner - base), status: 0, place: 0, time, cost }
}

type Columns = ReturnType<typeof columnsFor>

/** The index of the session with `id` in `rows`. The first row when no row has it. */
function indexOfId(rows: ReadonlyArray<SessionRow>, id: string) {
  return Math.max(0, rows.findIndex((row) => row.id === id))
}

/** The title in `width` cells, cut with `…`. The session that is open now has `(current)` after it. */
function TitleCell({ title, current, width }: { title: string; current: boolean; width: number }) {
  const mark = current ? CURRENT_MARK : ''
  const shown = cutEnd(title, width - Bun.stringWidth(mark))
  const rest = width - Bun.stringWidth(shown)
  return (
    <>
      {shown}
      <span fg={color.muted}>{padWidth(cutEnd(mark, rest), rest)}</span>
    </>
  )
}

/** The new title while the user types it, in `width` cells: its end, then the cursor. */
function DraftCell({ text, width }: { text: string; width: number }) {
  const shown = cutStart(text, width - 1)
  return (
    <>
      {shown}
      <span bg={color.linen}> </span>
      {padWidth('', width - 1 - Bun.stringWidth(shown))}
    </>
  )
}

/** One session: the glyph, the title, the status word, the place, the time ago, and the cost. */
function SessionLine({ session, columns, now, selected, current, draft }: {
  session: SessionRow
  columns: Columns
  now: number
  selected: boolean
  current: boolean
  /** The new title, while the user renames this session. */
  draft?: string
}) {
  const status = STATUS[session.status]
  const cells = cellsOf(session, now)
  const gap = ' '.repeat(GAP)
  return (
    <ListRow selected={selected}>
      <span fg={status.fg}>{status.glyph}</span>
      {' '}
      {draft === undefined ? (
        <TitleCell title={titleOf(session)} current={current} width={columns.title} />
      ) : (
        <DraftCell text={draft} width={columns.title} />
      )}
      {columns.status === 0 ? null : (
        <span fg={status.fg}>{gap + cells.status.padEnd(columns.status)}</span>
      )}
      {columns.place === 0 ? null : (
        <span fg={color.muted}>{gap + cells.place.padEnd(columns.place)}</span>
      )}
      <span fg={color.muted}>{gap + cells.time.padStart(columns.time)}</span>
      {columns.cost === 0 ? null : (
        <span fg={color.muted}>{gap + cells.cost.padStart(columns.cost)}</span>
      )}
    </ListRow>
  )
}

/**
 * The session picker (ctrl+o), a box over the rest of heddle. It lists the
 * sessions of the folder. Each row has the status glyph (`●` live, `◌` needs
 * you, `✓` done), the title, the status, where the tools run, the time of
 * the last change, and the cost. `(current)` marks the session that is open
 * now. The user types to search the titles, in any case.
 *
 * - ↑↓ move the selection.
 * - Enter calls `onClose()`, then `onOpen(id)`.
 * - `f` calls `onClose()`, then `onFork(id)`.
 * - `n` calls `onClose()`, then `onNew()`.
 * - `r` puts the title in a field. Enter calls `onRename(id, title)` and esc
 *   cancels. The picker stays open.
 * - Esc calls `onClose()`.
 *
 * `f`, `r`, and `n` are commands only while the search is empty. When the
 * search has text, they are letters of the search. A capital letter always
 * goes into the search, so `F` starts a search for "fix".
 *
 * While it shows, the picker takes every key and every paste: a focused
 * composer under it gets none. Render it as the last child of the box that
 * fills the terminal, and only while it is open.
 *
 * @param sessions The sessions of the folder, in the order to show them.
 * @param currentId The id of the session that is open now.
 * @param now The time that "2 hours ago" counts from. The default is `Date.now()`.
 * @param onOpen Opens the session with `id`.
 * @param onNew Starts a new session.
 * @param onFork Makes a copy of the session with `id`, and opens it.
 * @param onRename Gives the session with `id` the new `title`.
 * @param onClose Called when the picker must close.
 * @example
 * {overlay === 'sessions' ? (
 *   <SessionPicker
 *     sessions={rows}
 *     currentId={session.id}
 *     onOpen={openSession}
 *     onNew={startSession}
 *     onFork={forkSession}
 *     onRename={renameSession}
 *     onClose={() => setOverlay(null)}
 *   />
 * ) : null}
 */
export function SessionPicker({
  sessions,
  currentId,
  now = Date.now(),
  onOpen,
  onNew,
  onFork,
  onRename,
  onClose,
}: {
  sessions: ReadonlyArray<SessionRow>
  currentId?: string
  now?: number
  onOpen(id: string): void
  onNew(): void
  onFork(id: string): void
  onRename(id: string, title: string): void
  onClose(): void
}) {
  const layout = useOverlayLayout()
  /** The id of the selected session. An id that no row has selects the first row. */
  const selectedId = useKeyState('')
  /** True while the user types a new title for the selected session. */
  const renaming = useKeyState(false)
  // A new search text selects its first match.
  const search = useLine({ isActive: () => !renaming.now(), onEdit: () => selectedId.set('') })
  const draft = useLine({ isActive: () => renaming.now() })

  useKeyboard((key) => {
    // The picker takes every key, so the composer under it gets none.
    key.preventDefault()
    if (renaming.now()) {
      if (key.name === 'escape') {
        renaming.set(false)
        return
      }
      if (isEnter(key)) {
        const title = draft.now().trim()
        renaming.set(false)
        if (title !== '') onRename(selectedId.now(), title)
        return
      }
      draft.press(key)
      return
    }
    const rows = filterByText(sessions, search.now(), titleOf)
    const index = indexOfId(rows, selectedId.now())
    const row = rows.at(index)
    if (isEnter(key)) {
      if (row === undefined) return
      onClose()
      onOpen(row.id)
      return
    }
    switch (key.name) {
      case 'escape':
        onClose()
        return
      case 'up':
        if (index > 0) selectedId.set(rows[index - 1].id)
        return
      case 'down':
        if (index < rows.length - 1) selectedId.set(rows[index + 1].id)
        return
    }
    const isSearchEmpty = search.now() === ''
    const command = isSearchEmpty ? typedText(key) : undefined
    switch (command) {
      case 'f':
        if (row === undefined) return
        onClose()
        onFork(row.id)
        return
      case 'r':
        if (row === undefined) return
        selectedId.set(row.id)
        draft.set(titleOf(row))
        renaming.set(true)
        return
      case 'n':
        onClose()
        onNew()
        return
    }
    search.press(key)
  })

  const rows = filterByText(sessions, search.text, titleOf)
  const index = indexOfId(rows, selectedId.value)
  const start = windowStart(rows.length, index, layout.rows)
  const columns = columnsFor(
    sessions.map((session) => cellsOf(session, now)),
    layout.inner,
  )
  return (
    <Overlay
      layout={layout}
      title="Sessions"
      aside={`${sessions.length} in this folder`}
      search={search.text}
      searchFocused={!renaming.value}
      hints={renaming.value ? RENAME_HINTS : LIST_HINTS}
    >
      {rows.length === 0 ? (
        <text fg={color.muted}>{sessions.length === 0 ? NO_SESSIONS : NO_MATCH}</text>
      ) : (
        rows.slice(start, start + layout.rows).map((session, offset) => {
          // Enter saves the new title for `selectedId`, so the field is on that row.
          const isRenamed = renaming.value && session.id === selectedId.value
          return (
            <SessionLine
              key={session.id}
              session={session}
              columns={columns}
              now={now}
              selected={start + offset === index}
              current={session.id === currentId}
              draft={isRenamed ? draft.text : undefined}
            />
          )
        })
      )}
    </Overlay>
  )
}
