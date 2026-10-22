import type { KeyBinding, TextareaRenderable } from '@opentui/core'
import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import type { ViewCommand } from '@tanstack/ai-harness/view'
import { useEffect, useRef, useState } from 'react'
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

/** Words that voice input wrote down. A new `id` puts `text` in the input once. */
export interface Dictation {
  id: number
  text: string
}

/** The selected row of the popup, and the text that the row was selected for. */
interface Picked {
  text: string
  index: number
}

/** No command opens a list. */
const NO_LISTS: ReadonlySet<string> = new Set()

/** No sent lines yet. */
const NO_HISTORY: ReadonlyArray<string> = []

/** No `@` paths. */
const noPaths = () => []

/** The sent line that ↑↓ show, and the text that was in the input before the first ↑. */
interface Recall {
  index: number
  draft: string
}

/** True while the user types a command name: the text starts with `/`, and has no space, tab, or new line yet. */
function isCommandName(text: string) {
  return /^\/\S*$/.test(text)
}

/**
 * The rows of the popup for `text`, and the index of the selected row: the
 * commands for a command name, else the paths for an `@` path at the end.
 * There are no rows when esc closed the popup for this text. A new text
 * selects its first row.
 *
 * @param text The text of the input.
 * @param commands The commands of the session.
 * @param paths The rows of an `@` path at the end of a text.
 * @param closedFor The text for which esc closed the popup. It is empty when esc did not close it.
 * @param picked The selected row.
 */
function popupOf(
  text: string,
  commands: ReadonlyArray<ViewCommand>,
  paths: (text: string) => ReadonlyArray<Suggestion>,
  closedFor: string,
  picked: Picked,
) {
  // An empty `closedFor` closes nothing: an empty text has no rows.
  const isOpen = text !== '' && text !== closedFor
  const rows = !isOpen ? [] : isCommandName(text) ? suggest(text, commands) : paths(text)
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
 *   of the command. A command that needs text, such as `/goal`, goes in the
 *   input on enter too. Esc closes the popup until the next edit.
 * - An `@` path at the end of the text opens the popup of the files and the
 *   folders. Enter and tab put the path in the input.
 * - Without the popup, ↑ on the first line shows the line that was sent
 *   before, and ↓ on the last line the line after it.
 * - A new `dictation` goes at the end of the text, after a space. It does not send.
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
 * @param lists The names of the commands that open a list of choices, such as `model`.
 * @param history The lines that the user sent, oldest first.
 * @param paths The rows of an `@` path at the end of a text, from `pathRows`.
 * @param dictation The words of the last voice input.
 * @param onSubmit Called with the text that the user sends.
 * @example
 * <Composer
 *   commands={commands}
 *   focused={focus === 'composer'}
 *   placeholder="Ask heddle, or type / for a command"
 *   onSubmit={(text) => run(parseInput(text, commands))}
 * />
 */
export function Composer({
  commands,
  focused,
  placeholder,
  lists = NO_LISTS,
  history = NO_HISTORY,
  paths = noPaths,
  dictation,
  onSubmit,
}: {
  commands: ReadonlyArray<ViewCommand>
  focused: boolean
  placeholder?: string
  lists?: ReadonlySet<string>
  history?: ReadonlyArray<string>
  paths?: (text: string) => ReadonlyArray<Suggestion>
  dictation?: Dictation
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
  // The sent line that the input shows after ↑, until the next send.
  const recall = useKeyState<Recall | undefined>(undefined)

  /** Calls `onSubmit` with the text, then clears the input. A blank text sends nothing. */
  const send = () => {
    const field = input.current
    if (field === null) return
    const value = field.plainText
    if (value.trim() === '') return
    recall.set(undefined)
    onSubmit(value)
    field.clear()
  }

  /**
   * ↑ on the first line shows the sent line before, and ↓ on the last line
   * the sent line after. After the newest line, ↓ brings back the text that
   * was in the input. Gives true when it used the key.
   */
  const moveInHistory = (isUp: boolean) => {
    const field = input.current
    if (field === null) return false
    const row = field.visualCursor.visualRow
    const isAtEdge = isUp ? row === 0 : row === field.virtualLineCount - 1
    const at = recall.now()
    if (!isAtEdge || (!isUp && at === undefined)) return false
    const index = (at?.index ?? history.length) + (isUp ? -1 : 1)
    if (index < 0) return false
    const draft = at?.draft ?? field.plainText
    const text = index < history.length ? history[index] : draft
    recall.set(index < history.length ? { index, draft } : undefined)
    // A sent `/model` does not open the popup.
    closedFor.set(text)
    field.replaceText(text)
    field.gotoBufferEnd()
    return true
  }

  /** Puts `insert` in the input, with the cursor at its end. Undo brings back the typed text. */
  const complete = (insert: string) => {
    const field = input.current
    if (field === null) return
    field.replaceText(insert)
    field.gotoBufferEnd()
  }

  // Each new dictation goes at the end of the text, after a space.
  useEffect(() => {
    const field = input.current
    if (dictation === undefined || field === null) return
    const before = field.plainText
    const gap = before === '' || /\s$/.test(before) ? '' : ' '
    field.replaceText(`${before}${gap}${dictation.text}`)
    field.gotoBufferEnd()
  }, [dictation])

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
    const { rows, index } = popupOf(current, commands, paths, closedFor.now(), picked.now())
    const row = rows[index]
    // Without the popup, ↑↓ go through the sent lines, and the textarea gets the other keys.
    if (row === undefined) {
      const isArrow = key.name === 'up' || key.name === 'down'
      if (isArrow && moveInHistory(key.name === 'up')) key.preventDefault()
      return
    }
    if (SEND_KEYS.has(key.name)) {
      key.preventDefault()
      // A path goes in the input. A folder then shows what is in it.
      if (row.label.startsWith('@')) {
        complete(row.insert)
        return
      }
      // A command that needs text goes in the input, such as `/goal `. Enter
      // runs the others at once, and a command with a list opens its list.
      if (row.insert.endsWith(' ') && !lists.has(row.label.slice(1))) {
        complete(row.insert)
        return
      }
      recall.set(undefined)
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

  const popup = popupOf(text, commands, paths, closedFor.value, picked.value)
  const isPopupShown = focused && popup.rows.length > 0
  // The labels of the commands keep one width while the user types. A path is as wide as the paths.
  const labelWidth = widest((isCommandName(text) ? suggest('/', commands) : popup.rows).map((row) => row.label))
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
