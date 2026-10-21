import { HARNESS_EVENTS } from '@tanstack/ai-harness'
import { FileChanged } from '@tanstack/ai-harness/plugins/coding'
import type { SessionEvent } from '@tanstack/ai-harness'
import type { FileChange } from '@tanstack/ai-harness/plugins/coding'

/** One change of a file. */
export interface Patch {
  /** The unified diff. It is not set for a binary file, a big patch, or a `.env` file. */
  patch?: string
  additions: number
  deletions: number
  /** The tool call that made the change. */
  toolCallId?: string
  /** The time of the change, in milliseconds since 1970. */
  at: number
}

/** A file that the session changed, with all of its changes. */
export interface FileEntry {
  /** The absolute path, as the tools use it. */
  path: string
  /** The path from the tools root, with `/`. */
  rel: string
  /** The kind of the newest change. */
  change: FileChange['change']
  /** The sum of the added lines of all the patches. */
  additions: number
  /** The sum of the deleted lines of all the patches. */
  deletions: number
  /** The changes of the file, oldest first. */
  patches: Array<Patch>
}

/** The changed files of a session. */
export interface ChangesState {
  /** The files, in the order of their first change. */
  files: Array<FileEntry>
  /** The `rel` of the file with the newest change. */
  latest?: string
}

/** A live {@link ChangesState}, for `useSyncExternalStore` of React. */
export interface ChangesWatch {
  /** The state now. It is the same object until a change comes. */
  get(): ChangesState
  /** It calls `listener` after each change. It returns a function that stops the calls. */
  subscribe(listener: () => void): () => void
  /** It stops the read of the session events. */
  stop(): void
}

/**
 * It adds one file change to `state`, and gives the new state. It does not
 * change `state` itself.
 *
 * - A change of a file that has an entry adds a patch to that entry.
 * - A move renames the entry of its old path, and keeps its patches.
 * - A delete keeps the entry, with `change: 'deleted'`.
 *
 * `root` is the root of the tools. `at` is the time of the change.
 *
 * @example
 * ```ts
 * const next = applyChange(state, change, '/workspace', Date.now())
 * ```
 */
export function applyChange(
  state: ChangesState,
  change: FileChange,
  root: string,
  at: number,
) {
  const rel = relOf(change.path, root)
  // A move continues the entry of its old path.
  const oldRel = change.from === undefined ? rel : relOf(change.from, root)
  const old = state.files.find((file) => file.rel === oldRel)
  const base = old ?? { additions: 0, deletions: 0, patches: [] }
  const patch: Patch = {
    patch: change.patch,
    additions: change.additions,
    deletions: change.deletions,
    toolCallId: change.toolCallId,
    at,
  }
  const entry: FileEntry = {
    path: change.path,
    rel,
    change: change.change,
    additions: base.additions + change.additions,
    deletions: base.deletions + change.deletions,
    patches: [...base.patches, patch],
  }
  // Each path has one entry, so a move onto a path that has an entry
  // replaces that entry.
  const kept = state.files.filter((file) => file === old || file.rel !== rel)
  const files =
    old === undefined
      ? [...kept, entry]
      : kept.map((file) => (file === old ? entry : file))
  return { files, latest: rel }
}

/**
 * It keeps a {@link ChangesState} of the `FileChanged` events of a session.
 * It reads the events from the start of the session log, then each new
 * event, until `stop()`.
 *
 * `source` is the session. `root` is the root of its tools.
 *
 * @example
 * ```ts
 * const changes = watchChanges(session, root)
 * const state = useSyncExternalStore(changes.subscribe, changes.get)
 * // when the session closes:
 * changes.stop()
 * ```
 */
export function watchChanges(
  source: {
    events: (options: { signal?: AbortSignal }) => AsyncIterable<SessionEvent>
  },
  root: string,
) {
  const reader = new AbortController()
  const listeners = new Set<() => void>()
  let state: ChangesState = { files: [] }

  const read = async () => {
    // The call has no `from`, so the read begins at the start of the log.
    const events = source.events({ signal: reader.signal })
    for await (const entry of events) {
      const change = fileChangeOf(entry)
      if (change === undefined) continue
      const at = entry.event.timestamp ?? Date.now()
      state = applyChange(state, change, root, at)
      for (const listener of listeners) listener()
    }
  }
  // A read that fails ends the watch, and the state stays as it is. The
  // session view reads the same log, and it shows the error.
  read().catch(() => {})

  const watch: ChangesWatch = {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    stop: () => reader.abort(),
  }
  return watch
}

/** It gives `path` from `root`, with `/`. A path outside `root` stays whole. */
function relOf(path: string, root: string) {
  // Windows paths have `\`, and the paths of a Docker sandbox have `/`.
  const file = path.replaceAll('\\', '/')
  const folder = root.replaceAll('\\', '/').replace(/\/+$/, '')
  return file.startsWith(`${folder}/`) ? file.slice(folder.length + 1) : file
}

/** The kinds of change of a `FileChange`. The type makes sure that no kind is missing. */
const KINDS: Record<FileChange['change'], true> = {
  created: true,
  updated: true,
  deleted: true,
  moved: true,
}

/**
 * It is true when `value` has the fields of a `FileChange`. The value is JSON
 * from the session log, and a log of another harness version can have other
 * fields.
 */
function isFileChange(value: unknown): value is FileChange {
  if (typeof value !== 'object' || value === null) return false
  const fields: Partial<Record<keyof FileChange, unknown>> = value
  const texts = [fields.from, fields.patch, fields.toolCallId]
  return (
    typeof fields.path === 'string' &&
    typeof fields.change === 'string' &&
    Object.hasOwn(KINDS, fields.change) &&
    typeof fields.additions === 'number' &&
    typeof fields.deletions === 'number' &&
    texts.every((text) => text === undefined || typeof text === 'string')
  )
}

/** It gives the `FileChange` of a `FileChanged` event, or `undefined` for any other event. */
function fileChangeOf({ event }: SessionEvent) {
  const isPluginEvent =
    event.type === 'CUSTOM' && event.name === HARNESS_EVENTS.pluginEvent
  if (!isPluginEvent) return undefined
  // The value is JSON from the log, so its fields are unknown.
  const { name, value }: { name?: unknown; value?: unknown } = event.value ?? {}
  return name === FileChanged.name && isFileChange(value) ? value : undefined
}
