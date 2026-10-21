// Key and paste input that the bars, the overlays, and the composer share.
import { decodePasteBytes, stripAnsiSequences, type KeyEvent } from '@opentui/core'
import { usePaste } from '@opentui/react'
import { useRef, useState } from 'react'
import { graphemes } from '../utils'

/** The keys that send or pick, as in the OpenTUI input. */
const ENTER_KEYS = new Set(['return', 'kpenter', 'linefeed'])

/** A control code. A key with one in its sequence types nothing. */
const CONTROL = /[\x00-\x1f\x7f-\x9f]/

/** A key without ctrl, meta, super, or hyper. */
export function isPlain(key: KeyEvent) {
  return !key.ctrl && !key.meta && !key.super && !key.hyper
}

/**
 * The text that a key types, as the OpenTUI input reads it. `undefined` when
 * it types nothing, for example for an arrow or a key with ctrl.
 */
export function typedText(key: KeyEvent) {
  if (!isPlain(key)) return undefined
  if (key.name === 'space') return ' '
  const isText = key.sequence !== '' && !CONTROL.test(key.sequence)
  return isText ? key.sequence : undefined
}

/** True for enter. */
export function isEnter(key: KeyEvent) {
  return ENTER_KEYS.has(key.name)
}

/** Pasted bytes as text for one line: no escape codes, line breaks, or other control codes. */
export function pastedText(bytes: Uint8Array) {
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
