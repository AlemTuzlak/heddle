import type { KeyBinding, TextareaRenderable } from '@opentui/core'
import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import type { ViewCommand } from '@tanstack/ai-harness/view'
import { useRef, useState } from 'react'
import { suggest, type Suggestion } from '../state/commands'
import { cutEnd, padWidth, widest } from '../utils'
import { isPlain, useKeyState } from './keys'
import { ListRow, windowStart } from './Palette'
import { color } from './theme'

/** The most lines that the input shows. A longer text scrolls. */
const MAX_LINES = 6

/** The most rows that the `/` popup shows. The rows scroll to keep the selected row in view. */
const MAX_POPUP_ROWS = 6

/** The popup draws over the panes above the composer, but under the overlays (their `zIndex` is 100). */
const POPUP_Z_INDEX = 50

/** The columns of the popup that are not for its rows: the two borders and the two padding cells. */
const POPUP_FRAME_COLUMNS = 4

/** The cells in front of a label: the selection bar and a space. */
const LEAD = 2

/** The cells between the label and the detail. */
const GAP = 2

/**
 * The keys of the input. A key here replaces the default key of the textarea.
 *
 * - Enter (also on the keypad) sends.
 * - shift+enter adds a line.
 * - ctrl+j adds a line, for a terminal that sends enter the same with and
 *   without shift. An old terminal sends ctrl+j as a line feed. The textarea
 *   adds a line for a line feed by default.
 */
const KEY_BINDINGS: Array<KeyBinding> = [
  { name: 'return', action: 'submit' },
  { name: 'kpenter', action: 'submit' },
  { name: 'return', shift: true, action: 'newline' },
  { name: 'j', ctrl: true, action: 'newline' },
]

/**
 * The keys that send, or that complete a row of the popup. A line feed
 * (ctrl+j in an old terminal) adds a line, so it is not here.
 */
const SEND_KEYS: ReadonlySet<string> = new Set(['return', 'kpenter'])

/** The selected row of the popup, and the text that the row was selected for. */
interface Picked {
  text: string
  index: number
}

/** True while the user types a command name: the text starts with `/`, and has no space, tab, or new line yet. */
function isCommandName(text: string) {
  return /^\/\S*$/.test(text)
}

/**
 * The rows of the popup for `text`, and the index of the selected row. There
 * are no rows when `text` is not a command name, or when esc closed the popup
 * for this text. A new text selects its first row.
 *
 * @param text The text of the input.
 * @param commands The commands of the session.
 * @param closedFor The text for which esc closed the popup. It is empty when esc did not close it.
 * @param picked The selected row.
 */
function popupOf(text: string, commands: ReadonlyArray<ViewCommand>, closedFor: string, picked: Picked) {
  // A command name is never empty, so an empty `closedFor` closes nothing.
  const isOpen = isCommandName(text) && text !== closedFor
  const rows = isOpen ? suggest(text, commands) : []
  const index = picked.text === text ? picked.index : 0
  return { rows, index: Math.max(0, Math.min(index, rows.length - 1)) }
}

/**
 * The `/` popup, over the panes and just above the input: at most 6 rows, and
 * the selected row has the indigo bar.
 *
 * @param rows The rows that match the text.
 * @param index The index of the selected row in `rows`.
 * @param labelWidth The cells of the widest label of all commands, so that the details do not move while the user types.
 * @param width The cells of the composer. The composer is as wide as the terminal.
 */
function Popup({ rows, index, labelWidth, width }: {
  rows: ReadonlyArray<Suggestion>
  index: number
  labelWidth: number
  width: number
}) {
  const inner = Math.max(1, width - POPUP_FRAME_COLUMNS)
  const label = Math.min(labelWidth, Math.floor((inner - LEAD) / 2))
  const detail = Math.max(0, inner - LEAD - label - GAP)
  const start = windowStart(rows.length, index, MAX_POPUP_ROWS)
  const shown = rows.slice(start, start + MAX_POPUP_ROWS)
  return (
    <box
      position="absolute"
      bottom="100%"
      left={0}
      width="100%"
      zIndex={POPUP_Z_INDEX}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={color.indigoDim}
      backgroundColor={color.surface}
      paddingX={1}
    >
      {shown.map((row, offset) => (
        <ListRow key={row.label} selected={start + offset === index}>
          {' '}
          {padWidth(cutEnd(row.label, label), label)}
          <span fg={color.muted}>{' '.repeat(GAP) + cutEnd(row.detail, detail)}</span>
        </ListRow>
      ))}
    </box>
  )
}

/**
 * The input at the bottom of heddle: the indigo `›` and a text area in a
 * rounded frame. The frame grows with the lines of the text, up to 6 lines.
 * Then the text scrolls.
 *
 * - Enter calls `onSubmit` with the text, then clears the input. A blank text
 *   sends nothing. The text keeps its new lines.
 * - shift+enter and ctrl+j add a line. A paste goes in whole, with its lines.
 * - A text that starts with `/` and has no space yet opens the popup of the
 *   matching commands, just above the input. ↑↓ move the selection. Enter
 *   runs the selected command, and tab completes the text, to type the input
 *   of the command. Esc closes the popup until the next edit.
 *
 * The composer is 3 rows high for one line, and 8 rows high for 6 lines. The
 * popup takes no rows of the layout. It draws over at most 8 rows above the
 * composer: 6 rows and its frame. Its rows fit the width of the terminal, so
 * render the composer across the full width.
 *
 * The keys and the pastes go to the composer only while `focused` is true.
 * While the popup shows, the composer takes up, down, tab, enter, and esc, and
 * calls `preventDefault()` on them. A key handler of the app must skip a key
 * when `key.defaultPrevented` is true. For this, the handler of the composer
 * must run first. React starts the effects of a child before the effects of
 * its parent. So render the composer from the first render of the app, and do
 * not give it a new `key`.
 *
 * @param commands The commands of the session, from `view.store.get().commands`.
 * @param focused True while the composer has the keys.
 * @param placeholder The text that shows while the input is empty.
 * @param onSubmit Called with the text that the user sends.
 * @example
 * <Composer
 *   commands={commands}
 *   focused={focus === 'composer'}
 *   placeholder="Ask heddle, or type / for a command"
 *   onSubmit={(text) => run(parseInput(text, commands))}
 * />
 */
export function Composer({ commands, focused, placeholder, onSubmit }: {
  commands: ReadonlyArray<ViewCommand>
  focused: boolean
  placeholder?: string
  onSubmit(text: string): void
}) {
  const terminal = useTerminalDimensions()
  const input = useRef<TextareaRenderable>(null)
  // The text for the draw. A key handler reads `input.current.plainText`
  // instead, because keys can come before React draws again (OpenTUI issue #1660).
  const [text, setText] = useState('')
  const picked = useKeyState({ text: '', index: 0 })
  // The text for which esc closed the popup. It is empty when esc did not close it.
  const closedFor = useKeyState('')

  /** Calls `onSubmit` with the text, then clears the input. A blank text sends nothing. */
  const send = () => {
    const field = input.current
    if (field === null) return
    const value = field.plainText
    if (value.trim() === '') return
    onSubmit(value)
    field.clear()
  }

  /** Puts `insert` in the input, with the cursor at its end. Undo brings back the typed text. */
  const complete = (insert: string) => {
    const field = input.current
    if (field === null) return
    field.replaceText(insert)
    field.gotoBufferEnd()
  }

  const onContentChange = () => {
    const value = input.current?.plainText ?? ''
    setText(value)
    // An edit opens the popup again after esc closed it.
    if (value !== closedFor.now()) closedFor.set('')
  }

  useKeyboard((key) => {
    // The popup takes only plain keys, and only a key that no other handler took.
    const isFree = focused && !key.defaultPrevented && isPlain(key) && !key.shift
    const field = input.current
    if (!isFree || field === null) return
    const current = field.plainText
    const { rows, index } = popupOf(current, commands, closedFor.now(), picked.now())
    const row = rows[index]
    // Without the popup, the textarea gets the key.
    if (row === undefined) return
    if (SEND_KEYS.has(key.name)) {
      key.preventDefault()
      // Enter runs the selected command at once. Tab completes it, to type its input.
      onSubmit(row.insert.trim())
      field.clear()
      return
    }
    switch (key.name) {
      case 'up':
        key.preventDefault()
        picked.set({ text: current, index: Math.max(0, index - 1) })
        return
      case 'down':
        key.preventDefault()
        picked.set({ text: current, index: Math.min(rows.length - 1, index + 1) })
        return
      case 'tab':
        key.preventDefault()
        complete(row.insert)
        return
      case 'escape':
        key.preventDefault()
        closedFor.set(current)
        return
    }
  })

  const popup = popupOf(text, commands, closedFor.value, picked.value)
  const isPopupShown = focused && popup.rows.length > 0
  const labelWidth = widest(suggest('/', commands).map((row) => row.label))
  return (
    <box flexDirection="column" flexShrink={0}>
      {isPopupShown ? (
        <Popup rows={popup.rows} index={popup.index} labelWidth={labelWidth} width={terminal.width} />
      ) : null}
      <box
        border
        borderStyle="rounded"
        borderColor={focused ? color.indigoDim : color.line}
        paddingX={1}
        flexDirection="row"
        columnGap={1}
      >
        <text fg={color.indigo} flexShrink={0}>
          <strong>›</strong>
        </text>
        <textarea
          ref={input}
          focused={focused}
          placeholder={placeholder}
          keyBindings={KEY_BINDINGS}
          onSubmit={send}
          onContentChange={onContentChange}
          flexGrow={1}
          maxHeight={MAX_LINES}
          textColor={color.linen}
          focusedTextColor={color.linen}
          cursorColor={color.linen}
          placeholderColor={color.muted}
        />
      </box>
    </box>
  )
}
