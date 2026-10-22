// React hooks that read a live session view and other live state.
import type { SessionViewState } from '@tanstack/ai-harness/view'
import { useCallback, useSyncExternalStore } from 'react'

/**
 * The store of a session view, as the hooks read it. The `store` of a
 * `SessionView` fits, and so does a small fake in a test.
 */
export interface ViewStore {
  get(): SessionViewState
  subscribe(listener: () => void): { unsubscribe(): void }
}

/**
 * Reads a part of the state of a session view, and draws again when that
 * part changes.
 *
 * `select` must give the same value until the state changes: give a part of
 * the state (`state.messages`, `state.status`), not a new object or array.
 * A new value for each call makes React draw again and again.
 *
 * @param view A `SessionView`, or any object with its `store`.
 * @param select Gives the part of the state to read.
 * @example
 * const messages = useView(session.view, (state) => state.messages)
 * const status = useView(session.view, (state) => state.status)
 */
export function useView<T>(view: { store: ViewStore }, select: (state: SessionViewState) => T) {
  const { store } = view
  const subscribe = useCallback(
    (listener: () => void) => {
      const subscription = store.subscribe(listener)
      return () => subscription.unsubscribe()
    },
    [store],
  )
  return useSyncExternalStore(subscribe, () => select(store.get()))
}

/**
 * Reads a live value, such as the changes of a session (`ChangesWatch`), and
 * draws again when it changes. `get()` must give the same value until a
 * change comes.
 *
 * @param watch Gives the value now, and calls a listener after each change.
 * @example
 * const changes = useWatch(session.changes)
 */
export function useWatch<T>(watch: { get(): T; subscribe(listener: () => void): () => void }) {
  const subscribe = useCallback((listener: () => void) => watch.subscribe(listener), [watch])
  return useSyncExternalStore(subscribe, () => watch.get())
}
