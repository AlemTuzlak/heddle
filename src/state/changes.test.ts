import { expect, setSystemTime, test } from 'bun:test'
import { EventType } from '@tanstack/ai'
import { HARNESS_EVENTS } from '@tanstack/ai-harness'
import { FileChanged, JobOutput } from '@tanstack/ai-harness/plugins/coding'
import { applyChange, watchChanges } from './changes'
import type { SessionEvent } from '@tanstack/ai-harness'
import type { FileChange } from '@tanstack/ai-harness/plugins/coding'
import type { ChangesState, ChangesWatch } from './changes'

const ROOT = '/work'

/** A change of `/work/src/a.ts` that adds one line. */
function fileChange(overrides: Partial<FileChange> = {}): FileChange {
  return {
    path: '/work/src/a.ts',
    change: 'updated',
    additions: 1,
    deletions: 0,
    ...overrides,
  }
}

/** It folds `changes` into an empty state. Their times are 1000, 2000, and so on. */
function applyAll(changes: Array<FileChange>, root = ROOT) {
  let state: ChangesState = { files: [] }
  for (const [index, change] of changes.entries()) {
    state = applyChange(state, change, root, (index + 1) * 1000)
  }
  return state
}

/** The session event of a plugin event named `name`, as the log keeps it. */
function pluginEvent(
  name: string,
  value: unknown,
  timestamp?: number,
): SessionEvent {
  return {
    cursor: '1',
    threadId: 'thread-1',
    operationId: 'session',
    event: {
      type: 'CUSTOM',
      name: HARNESS_EVENTS.pluginEvent,
      value: { plugin: 'tanstack/workspace-tools', name, value },
      timestamp,
    },
  }
}

const fileChanged = (change: FileChange, timestamp?: number) =>
  pluginEvent(FileChanged.name, change, timestamp)

const jobOutput = pluginEvent(JobOutput.name, { jobId: 'bash-1', output: 'ok' })

/** A text event of the model. It is not a file change. */
const text: SessionEvent = {
  cursor: '1',
  threadId: 'thread-1',
  operationId: 'turn-1',
  event: {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: 'message-1',
    delta: 'I will fix the test.',
  },
}

/**
 * A fake session log. `events` gives `history`, then each event of `push`,
 * until its signal aborts.
 */
function fakeLog(history: Array<SessionEvent>) {
  const queue = [...history]
  let wake = () => {}
  const source = {
    async *events({ signal }: { signal?: AbortSignal }) {
      while (signal?.aborted !== true) {
        const next = queue.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        await new Promise<void>((resolve) => {
          wake = resolve
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    },
  }
  const push = (event: SessionEvent) => {
    queue.push(event)
    wake()
  }
  return { source, push }
}

/** It resolves after the next change of `watch`. */
function nextChange(watch: ChangesWatch) {
  return new Promise<void>((resolve) => {
    const stop = watch.subscribe(() => {
      stop()
      resolve()
    })
  })
}

/** It resolves after all the work that waits now. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The rel and the patch times of each file of `watch`. */
const timesOf = (watch: ChangesWatch) =>
  watch.get().files.map(({ rel, patches }) => ({
    rel,
    at: patches.map((patch) => patch.at),
  }))

test('two edits of one file sum', () => {
  const once = applyChange(
    { files: [] },
    fileChange({ patch: 'patch 1', additions: 2, deletions: 1, toolCallId: 'call-1' }),
    ROOT,
    1000,
  )
  const twice = applyChange(
    once,
    fileChange({ patch: 'patch 2', additions: 3, deletions: 0, toolCallId: 'call-2' }),
    ROOT,
    2000,
  )
  expect(twice).toEqual({
    files: [
      {
        path: '/work/src/a.ts',
        rel: 'src/a.ts',
        change: 'updated',
        additions: 5,
        deletions: 1,
        patches: [
          { patch: 'patch 1', additions: 2, deletions: 1, toolCallId: 'call-1', at: 1000 },
          { patch: 'patch 2', additions: 3, deletions: 0, toolCallId: 'call-2', at: 2000 },
        ],
      },
    ],
    latest: 'src/a.ts',
  })
  // The fold does not change the state that it gets.
  expect(once.files[0]?.patches).toHaveLength(1)
})

test('a move renames the entry', () => {
  const state = applyAll([
    fileChange({ path: '/work/src/a.ts', patch: 'patch 1', additions: 2 }),
    fileChange({ path: '/work/src/b.ts', patch: 'patch 2' }),
    fileChange({
      path: '/work/lib/a.ts',
      from: '/work/src/a.ts',
      change: 'moved',
      patch: 'patch 3',
      additions: 0,
    }),
  ])
  expect(state).toEqual({
    files: [
      {
        path: '/work/lib/a.ts',
        rel: 'lib/a.ts',
        change: 'moved',
        additions: 2,
        deletions: 0,
        patches: [
          { patch: 'patch 1', additions: 2, deletions: 0, at: 1000 },
          { patch: 'patch 3', additions: 0, deletions: 0, at: 3000 },
        ],
      },
      {
        path: '/work/src/b.ts',
        rel: 'src/b.ts',
        change: 'updated',
        additions: 1,
        deletions: 0,
        patches: [{ patch: 'patch 2', additions: 1, deletions: 0, at: 2000 }],
      },
    ],
    latest: 'lib/a.ts',
  })
})

test('a move onto a changed path keeps one entry', () => {
  const state = applyAll([
    fileChange({ path: '/work/old.ts', patch: 'patch 1' }),
    fileChange({ path: '/work/new.ts', change: 'deleted', patch: 'patch 2' }),
    fileChange({ path: '/work/new.ts', from: '/work/old.ts', change: 'moved', patch: 'patch 3' }),
  ])
  const files = state.files.map(({ rel, change, patches }) => ({
    rel,
    change,
    patches: patches.map((patch) => patch.patch),
  }))
  expect(files).toEqual([
    { rel: 'new.ts', change: 'moved', patches: ['patch 1', 'patch 3'] },
  ])
})

test('a delete keeps the entry', () => {
  const state = applyAll([
    fileChange({ change: 'created', patch: 'patch 1', additions: 2 }),
    fileChange({ change: 'deleted', patch: 'patch 2', additions: 0, deletions: 2 }),
  ])
  expect(state).toEqual({
    files: [
      {
        path: '/work/src/a.ts',
        rel: 'src/a.ts',
        change: 'deleted',
        additions: 2,
        deletions: 2,
        patches: [
          { patch: 'patch 1', additions: 2, deletions: 0, at: 1000 },
          { patch: 'patch 2', additions: 0, deletions: 2, at: 2000 },
        ],
      },
    ],
    latest: 'src/a.ts',
  })
})

test('rel uses / for Windows paths', () => {
  const state = applyAll(
    [
      fileChange({ path: 'C:\\work\\app\\src\\ui\\a.ts' }),
      // A path outside the root, which a permission rule can allow.
      fileChange({ path: 'D:\\notes\\todo.md' }),
    ],
    'C:\\work\\app',
  )
  expect(state.files.map((file) => file.rel)).toEqual([
    'src/ui/a.ts',
    'D:/notes/todo.md',
  ])
})

test('watchChanges reads history and live events', async () => {
  const { source, push } = fakeLog([
    text,
    // The event of another plugin, with the same fields.
    pluginEvent('acme/backup:file-saved', fileChange({ path: '/work/copy.ts' })),
    fileChanged(fileChange({ path: '/work/src/a.ts' }), 1000),
  ])
  const watch = watchChanges(source, ROOT)
  await nextChange(watch)
  expect(timesOf(watch)).toEqual([{ rel: 'src/a.ts', at: [1000] }])

  const changed = nextChange(watch)
  push(fileChanged(fileChange({ path: '/work/src/b.ts', change: 'created' }), 2000))
  await changed
  expect(timesOf(watch)).toEqual([
    { rel: 'src/a.ts', at: [1000] },
    { rel: 'src/b.ts', at: [2000] },
  ])
  expect(watch.get().latest).toBe('src/b.ts')
  watch.stop()
})

test('the watch skips a file change with a bad value', async () => {
  const { source } = fakeLog([
    // An event of another harness version, with no line counts.
    pluginEvent(FileChanged.name, { path: '/work/src/old.ts', change: 'updated' }, 1000),
    fileChanged(fileChange({ path: '/work/src/new.ts' }), 2000),
  ])
  const watch = watchChanges(source, ROOT)
  await nextChange(watch)
  expect(timesOf(watch)).toEqual([{ rel: 'src/new.ts', at: [2000] }])
  watch.stop()
})

test('a change without a time uses the clock', async () => {
  setSystemTime(new Date(5000))
  try {
    const { source } = fakeLog([fileChanged(fileChange())])
    const watch = watchChanges(source, ROOT)
    await nextChange(watch)
    expect(timesOf(watch)).toEqual([{ rel: 'src/a.ts', at: [5000] }])
    watch.stop()
  } finally {
    // Without a date, the clock is real again.
    setSystemTime()
  }
})

test('get() is stable without changes', async () => {
  const { source, push } = fakeLog([text])
  const watch = watchChanges(source, ROOT)
  const first = watch.get()
  push(jobOutput)
  await settle()
  expect(watch.get()).toBe(first)

  // A change gives a new object, so React draws again.
  const changed = nextChange(watch)
  push(fileChanged(fileChange(), 1000))
  await changed
  expect(watch.get()).not.toBe(first)
  watch.stop()
})

test('stop() ends the read', async () => {
  const { source, push } = fakeLog([])
  const watch = watchChanges(source, ROOT)
  watch.stop()
  push(fileChanged(fileChange(), 1000))
  await settle()
  expect(watch.get().files).toEqual([])
})
