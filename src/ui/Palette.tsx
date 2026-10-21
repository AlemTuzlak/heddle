import { decodePasteBytes, stripAnsiSequences, type KeyEvent } from '@opentui/core'
import { useKeyboard, usePaste, useTerminalDimensions } from '@opentui/react'
import { useRef, useState, type ReactNode } from 'react'
import { Hints, type Hint } from './Hints'
import { color } from './theme'

// The parts from here to `PaletteItem` are the parts of an overlay. The
// palette and the session picker (`SessionPicker.tsx`) both use them.

/** The overlays draw over the rest of heddle. */
const OVERLAY_Z_INDEX = 100

/** An overlay starts on the row under the header. */
const OVERLAY_TOP = 1

/** The part of the terminal width that an overlay takes, as in the mockup. */
const WIDTH_SHARE = 0.82

/** An overlay is at least this wide when the terminal has the room. */
const MIN_WIDTH = 60

/** An overlay is at most this wide. */
const MAX_WIDTH = 100

/** The columns of an overlay that are not for its rows: the two borders and the two padding cells. */
const FRAME_COLUMNS = 4

/**
 * The rows of the terminal that are not list rows: the row above the overlay,
 * its two borders, the title, the search box (3 rows), the blank row and the
 * keys under the list, and one free row under the overlay.
 */
const FRAME_ROWS = 10

/** The columns of the search box that are not for the text: its borders, its padding, `⌕ `, and the cursor. */
const SEARCH_FRAME_COLUMNS = 7

/** The background of the selected row, as in the mockup. */
const SELECTED_BG = '#23222f'

/** The bar at the left end of the selected row. */
const SELECTED_BAR = '▎'

/** The mark at the end or at the start of a text that is cut. */
const ELLIPSIS = '…'

/** The keys that pick the selected row, as in the OpenTUI input. */
const ENTER_KEYS = new Set(['return', 'kpenter', 'linefeed'])

/** A control code. A key with one in its sequence types nothing. */
const CONTROL = /[\x00-\x1f\x7f-\x9f]/

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The characters of `text` as the user sees them: an emoji with its modifiers is one. */
function graphemes(text: string) {
  return Array.from(graphemeSegmenter.segment(text), (part) => part.segment)
}

/** The first characters that fill at most `width` cells. */
function takeWidth(characters: ReadonlyArray<string>, width: number) {
  const taken: Array<string> = []
  let used = 0
  for (const character of characters) {
    const cells = Bun.stringWidth(character)
    if (used + cells > width) break
    taken.push(character)
    used += cells
  }
  return taken
}

/**
 * `text` in at most `width` cells. A longer text keeps its start and ends
 * with `…`.
 *
 * @example
 * cutEnd('Fix the failing add test', 10) // 'Fix the f…'
 */
export function cutEnd(text: string, width: number) {
  if (width < 1) return ''
  if (Bun.stringWidth(text) <= width) return text
  return takeWidth(graphemes(text), width - 1).join('') + ELLIPSIS
}

/**
 * `text` in at most `width` cells. A longer text keeps its end and starts
 * with `…`, so the place where the user types stays in view.
 *
 * @example
 * cutStart('Fix the failing add test', 10) // '…add test'
 */
export function cutStart(text: string, width: number) {
  if (width < 1) return ''
  if (Bun.stringWidth(text) <= width) return text
  const characters = graphemes(text).reverse()
  return ELLIPSIS + takeWidth(characters, width - 1).reverse().join('')
}

/** `text` with spaces after it, so that it fills `width` cells. */
export function padWidth(text: string, width: number) {
  return text + ' '.repeat(Math.max(0, width - Bun.stringWidth(text)))
}

/**
 * The text that a key types, as the OpenTUI input reads it. `undefined` when
 * it types nothing, for example for an arrow or a key with ctrl.
 */
export function typedText(key: KeyEvent) {
  const isPlain = !key.ctrl && !key.meta && !key.super && !key.hyper
  if (!isPlain) return undefined
  if (key.name === 'space') return ' '
  const isText = key.sequence !== '' && !CONTROL.test(key.sequence)
  return isText ? key.sequence : undefined
}

/** True for enter. */
export function isEnter(key: KeyEvent) {
  return ENTER_KEYS.has(key.name)
}

/**
 * The items whose text has `query`, in any case, in their order.
 *
 * @param items The items to search.
 * @param query The search text.
 * @param textOf The text of an item that the search reads.
 * @example
 * filterByText(items, 'mod', (item) => item.label)
 */
export function filterByText<T>(items: ReadonlyArray<T>, query: string, textOf: (item: T) => string) {
  const needle = query.toLowerCase()
  return items.filter((item) => textOf(item).toLowerCase().includes(needle))
}

/** Pasted bytes as text for one line: no escape codes, line breaks, or other control codes. */
function pastedText(bytes: Uint8Array) {
  return stripAnsiSequences(decodePasteBytes(bytes)).replace(/[\x00-\x1f\x7f-\x9f]/g, '')
}

/**
 * State that a key handler can read at once. Keys can come faster than React
 * draws, so a handler reads `now()`, and the render reads `value`.
 */
export function useKeyState<T>(initial: T) {
  const ref = useRef(initial)
  const [value, setValue] = useState(initial)
  const set = (next: T) => {
    ref.current = next
    setValue(next)
  }
  return { value, now: () => ref.current, set }
}

/**
 * A line of text that the user types or pastes. A key handler gives each key
 * to `press`. A paste adds to the line while `isActive()` is true.
 *
 * @param isActive True while the line takes the pastes.
 * @param onEdit Called after each key or paste that changes the line. `set` does not call it.
 */
export function useLine({ isActive, onEdit }: { isActive: () => boolean; onEdit?: () => void }) {
  const line = useKeyState('')
  const edit = (next: string) => {
    line.set(next)
    onEdit?.()
  }
  usePaste((event) => {
    if (!isActive()) return
    event.preventDefault()
    edit(line.now() + pastedText(event.bytes))
  })
  /** Types the text of `key`, or deletes the last character for backspace. Other keys do nothing. */
  const press = (key: KeyEvent) => {
    if (key.name === 'backspace') {
      edit(graphemes(line.now()).slice(0, -1).join(''))
      return
    }
    const typed = typedText(key)
    if (typed !== undefined) edit(line.now() + typed)
  }
  return { text: line.value, now: line.now, set: line.set, press }
}

/**
 * The place and the size of an overlay in this terminal: 82% of the width
 * (at least 60 and at most 100 columns), in the middle.
 */
export function useOverlayLayout() {
  const terminal = useTerminalDimensions()
  const share = Math.max(MIN_WIDTH, Math.round(terminal.width * WIDTH_SHARE))
  const width = Math.max(0, Math.min(terminal.width - 2, share, MAX_WIDTH))
  return {
    left: Math.floor((terminal.width - width) / 2),
    width,
    /** The cells of a row inside the border and the padding. */
    inner: Math.max(1, width - FRAME_COLUMNS),
    /** The most list rows that fit in the terminal. */
    rows: Math.max(1, terminal.height - FRAME_ROWS),
  }
}

/** The place and the size of an overlay. */
type OverlayLayout = ReturnType<typeof useOverlayLayout>

/** The first row to show, so that the selected row stays in view. It keeps the selected row in the middle. */
export function windowStart(count: number, selected: number, size: number) {
  return Math.max(0, Math.min(selected - Math.floor(size / 2), count - size))
}

/** One row of a list. The selected row has the indigo bar and a lighter background. Its children go in a `<text>`. */
export function ListRow({ selected, children }: { selected: boolean; children: ReactNode }) {
  return (
    <box height={1} flexShrink={0} backgroundColor={selected ? SELECTED_BG : 'transparent'}>
      <text fg={color.linen} wrapMode="none">
        <span fg={color.indigo}>{selected ? SELECTED_BAR : ' '}</span>
        {children}
      </text>
    </box>
  )
}

/**
 * The box of an overlay, over the rest of heddle: the title, the search box,
 * the rows (`children`), and the keys.
 *
 * @param layout The place and the size, from `useOverlayLayout()`.
 * @param title The title at the top left, for example `Sessions`.
 * @param aside The text at the top right, for example `6 in this folder`.
 * @param search The search text.
 * @param searchFocused True while the keys type into the search. The search shows the cursor.
 * @param hints The keys under the rows.
 */
export function Overlay({ layout, title, aside, search, searchFocused, hints, children }: {
  layout: OverlayLayout
  title: string
  aside?: string
  search: string
  searchFocused: boolean
  hints: ReadonlyArray<Hint>
  children: ReactNode
}) {
  return (
    <box
      position="absolute"
      top={OVERLAY_TOP}
      left={layout.left}
      width={layout.width}
      zIndex={OVERLAY_Z_INDEX}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={color.indigoDim}
      backgroundColor={color.surface}
      paddingX={1}
    >
      <box flexDirection="row" justifyContent="space-between" height={1} flexShrink={0}>
        <text fg={color.linen} wrapMode="none">
          <strong>{title}</strong>
        </text>
        {aside === undefined ? null : (
          <text fg={color.muted} wrapMode="none">
            {aside}
          </text>
        )}
      </box>
      <box border borderStyle="rounded" borderColor={color.line} paddingX={1} height={3} flexShrink={0}>
        <text fg={color.linen} wrapMode="none">
          <span fg={color.muted}>{'⌕ '}</span>
          {cutStart(search, layout.inner - SEARCH_FRAME_COLUMNS)}
          {searchFocused ? <span bg={color.linen}> </span> : null}
        </text>
      </box>
      {children}
      <box marginTop={1} flexShrink={0}>
        <Hints hints={hints} />
      </box>
    </box>
  )
}

// The palette.

/** One command of the palette. */
export interface PaletteItem {
  /** What the command does, for example `Switch the model`. The search reads it. */
  label: string
  /** More about the command, in the right column, for example `/model`. */
  detail?: string
  /** Runs the command. */
  run(): void
}

/** The cells in front of a label: the selection bar and a space. */
const PALETTE_LEAD = 2

/** The cells between the label and the detail. */
const GAP = 2

/** The keys under the commands. */
const PALETTE_HINTS: ReadonlyArray<Hint> = [
  { key: '↑↓', label: 'move' },
  { key: 'enter', label: 'run' },
  { key: 'esc', label: 'close' },
]

/** The palette text when it has no commands. */
const NO_COMMANDS = 'No commands.'

/** The palette text when no label has the search text. */
const NO_MATCH = 'No command matches the search.'

/** The label of a command, which the search reads. */
function labelOf(item: PaletteItem) {
  return item.label
}

/** The selected index in a list of `count` rows: at least 0, and at most the last row. */
function clampIndex(picked: number, count: number) {
  return Math.max(0, Math.min(picked, count - 1))
}

/**
 * The command palette (ctrl+k), a box over the rest of heddle. The user types
 * to search the labels, in any case.
 *
 * - ↑↓ move the selection.
 * - Enter calls `onClose()`, then the `run()` of the selected command. So a
 *   command can open another overlay.
 * - Esc calls `onClose()`.
 *
 * While it shows, the palette takes every key and every paste: a focused
 * composer under it gets none. Render it as the last child of the box that
 * fills the terminal, and only while it is open.
 *
 * @param items The commands, in the order to show them.
 * @param onClose Called when the palette must close.
 * @example
 * {overlay === 'palette' ? (
 *   <Palette items={[{ label: 'New session', run: startSession }]} onClose={() => setOverlay(null)} />
 * ) : null}
 */
export function Palette({ items, onClose }: { items: ReadonlyArray<PaletteItem>; onClose(): void }) {
  const layout = useOverlayLayout()
  /** The index of the selected command in the commands that match. */
  const picked = useKeyState(0)
  // A new search text selects its first match.
  const search = useLine({ isActive: () => true, onEdit: () => picked.set(0) })
  useKeyboard((key) => {
    // The palette takes every key, so the composer under it gets none.
    key.preventDefault()
    const shown = filterByText(items, search.now(), labelOf)
    const index = clampIndex(picked.now(), shown.length)
    if (isEnter(key)) {
      const item = shown[index]
      if (item === undefined) return
      onClose()
      item.run()
      return
    }
    switch (key.name) {
      case 'escape':
        onClose()
        return
      case 'up':
        if (index > 0) picked.set(index - 1)
        return
      case 'down':
        if (index < shown.length - 1) picked.set(index + 1)
        return
    }
    search.press(key)
  })

  const shown = filterByText(items, search.text, labelOf)
  const index = clampIndex(picked.value, shown.length)
  const start = windowStart(shown.length, index, layout.rows)
  // The detail column fits the widest detail of all commands, so it does not move while the user types.
  const details = items.map((item) => Bun.stringWidth(item.detail ?? ''))
  const detailWidth = Math.min(Math.max(0, ...details), Math.floor((layout.inner - PALETTE_LEAD) / 2))
  const labelWidth = layout.inner - PALETTE_LEAD - (detailWidth === 0 ? 0 : GAP + detailWidth)
  return (
    <Overlay layout={layout} title="Commands" search={search.text} searchFocused hints={PALETTE_HINTS}>
      {shown.length === 0 ? (
        <text fg={color.muted}>{items.length === 0 ? NO_COMMANDS : NO_MATCH}</text>
      ) : (
        shown.slice(start, start + layout.rows).map((item, offset) => (
          <ListRow key={item.label} selected={start + offset === index}>
            {' '}
            {padWidth(cutEnd(item.label, labelWidth), labelWidth)}
            {item.detail === undefined ? null : (
              <span fg={color.muted}>{' '.repeat(GAP) + cutEnd(item.detail, detailWidth)}</span>
            )}
          </ListRow>
        ))
      )}
    </Overlay>
  )
}
