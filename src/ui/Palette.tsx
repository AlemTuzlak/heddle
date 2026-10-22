import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import type { ReactNode } from 'react'
import { cutEnd, cutStart, padWidth } from '../utils'
import { Hints, type Hint } from './Hints'
import { isEnter, useKeyState, useLine } from './keys'
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

/** The bar at the left end of the selected row. */
const SELECTED_BAR = '▎'

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
    <box height={1} flexShrink={0} backgroundColor={selected ? color.selectedBg : 'transparent'}>
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
 * It also shows the choices of a command, such as the models of `/model`,
 * with another `title`.
 *
 * @param items The commands, in the order to show them.
 * @param title The title at the top left. Default: `Commands`.
 * @param onClose Called when the palette must close.
 * @example
 * {overlay === 'palette' ? (
 *   <Palette items={[{ label: 'New session', run: startSession }]} onClose={() => setOverlay(null)} />
 * ) : null}
 */
export function Palette({ items, title = 'Commands', onClose }: {
  items: ReadonlyArray<PaletteItem>
  title?: string
  onClose(): void
}) {
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
    <Overlay layout={layout} title={title} search={search.text} searchFocused hints={PALETTE_HINTS}>
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
