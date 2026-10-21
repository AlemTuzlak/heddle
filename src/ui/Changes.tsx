import { pathToFiletype, type SyntaxStyle } from '@opentui/core'
import { useKeyboard } from '@opentui/react'
import { useEffect } from 'react'
import type { ChangesState, FileEntry } from '../state/changes'
import { cutStart, padWidth, widest } from '../utils'
import { typedText, useKeyState } from './keys'
import { ListRow, windowStart } from './Palette'
import { color } from './theme'

/** The file list shows at most this many files. With more files, the list scrolls with the selection. */
const MAX_LIST_ROWS = 6

/** The file list takes at most this part of the pane, so that the diff keeps room in a short pane. */
const LIST_SHARE = 1 / 3

/** The cells in front of a path: the selection bar and a space. */
const LEAD = 2

/** The cells between two columns. */
const GAP = 2

/** A bar has at most this many `▮`. */
const MAX_BAR = 6

/** The start of a hunk in a unified diff. A patch without a hunk changes no line. */
const HUNK_HEADER = /^@@ /m

/** The text when the session changed no file. */
const NO_CHANGES = 'No file changes yet.'

/** The text instead of the diff of the newest patch of a deleted file. */
const DELETED = 'deleted'

/** The text for a patch without diff text: a binary file, a big patch, or a `.env` file. */
const NO_DIFF = 'no diff for this file'

/** The text for a patch without a hunk: a move with no edit, or a new empty file. */
const NO_LINE_CHANGED = 'no line changed'

/** A patch that the user stepped to with `[` and `]`. */
interface Step {
  /** The rel of its file. The step counts only while that file shows. */
  file: string
  /** The index of the patch in the patches of the file, from the oldest. */
  index: number
}

/** What the user chose with the keys. */
interface Choice {
  /** The rel of the file that the user picked with ↑↓. Without it, the pane follows the newest change. */
  file?: string
  /** The older patch that the user stepped to. Without it, the pane shows the newest patch. */
  step?: Step
}

/** No choice: the pane follows the newest change, and shows its newest patch. */
const FOLLOW: Choice = {}

/** The file that shows: the file that the user picked, or else the file of the newest change. */
function shownFileOf(state: ChangesState, choice: Choice) {
  const byRel = (rel: string | undefined) => state.files.find((file) => file.rel === rel)
  // A move gives a picked file a new rel. Then no file has the picked rel, and the pane follows.
  return byRel(choice.file) ?? byRel(state.latest) ?? state.files.at(-1)
}

/** The index of the patch of `file` that shows: the step of the user, or else the newest patch. */
function shownPatchOf(file: FileEntry, choice: Choice) {
  const newest = file.patches.length - 1
  const { step } = choice
  // A move onto a changed path can leave a file with fewer patches than the step.
  return step?.file === file.rel ? Math.min(step.index, newest) : newest
}

/** The rows of the file list for `count` files in a pane of `height` rows. */
function listRowsFor(count: number, height: number) {
  return Math.min(count, MAX_LIST_ROWS, Math.max(1, Math.floor(height * LIST_SHARE)))
}

/**
 * The `▮` cells of a file. More lines give more cells, on a log scale, and
 * at most `MAX_BAR`: 1 line gives 1 cell, 2 or 3 lines give 2, 4 to 7 give 3.
 * The added and the deleted lines share the cells, and a side with lines
 * gets at least one cell.
 */
function barOf(file: FileEntry) {
  const { additions, deletions } = file
  const lines = additions + deletions
  const cells = Math.min(MAX_BAR, Math.ceil(Math.log2(lines + 1)))
  if (additions === 0 || deletions === 0) {
    return { added: additions === 0 ? 0 : cells, removed: deletions === 0 ? 0 : cells }
  }
  const added = Math.min(cells - 1, Math.max(1, Math.round((cells * additions) / lines)))
  return { added, removed: cells - added }
}

/** The counts of a file, as the list shows them: `+N` and `−N`. */
function countsOf(file: FileEntry) {
  return { added: `+${file.additions}`, deleted: `−${file.deletions}` }
}

/**
 * The cells of each column of the file list in a row of `width` cells. The
 * bar and the counts fit their widest text, and the path gets the rest. The
 * bar does not show when no file has lines.
 */
function columnsFor(files: ReadonlyArray<FileEntry>, width: number) {
  const bar = Math.max(0, ...files.map(barOf).map(({ added, removed }) => added + removed))
  const counts = files.map(countsOf)
  const added = widest(counts.map((count) => count.added))
  const deleted = widest(counts.map((count) => count.deleted))
  const fixed = LEAD + (bar === 0 ? 0 : GAP + bar) + GAP + added + 1 + deleted
  return { path: Math.max(1, width - fixed), bar, added, deleted }
}

type Columns = ReturnType<typeof columnsFor>

/** One file of the list: the path, cut from the left, the bar, and `+N −N`. A count of 0 is faint. */
function FileLine({ file, columns, selected }: { file: FileEntry; columns: Columns; selected: boolean }) {
  const bar = barOf(file)
  const counts = countsOf(file)
  const gap = ' '.repeat(GAP)
  return (
    <ListRow selected={selected}>
      {' '}
      {padWidth(cutStart(file.rel, columns.path), columns.path)}
      {columns.bar === 0 ? null : (
        <>
          {gap}
          <span fg={color.woad}>{'▮'.repeat(bar.added)}</span>
          <span fg={color.madder}>{'▮'.repeat(bar.removed)}</span>
          {' '.repeat(columns.bar - bar.added - bar.removed)}
        </>
      )}
      {gap}
      <span fg={file.additions === 0 ? color.faint : color.woad}>
        {counts.added.padStart(columns.added)}
      </span>
      {' '}
      <span fg={file.deletions === 0 ? color.faint : color.madder}>
        {counts.deleted.padStart(columns.deleted)}
      </span>
    </ListRow>
  )
}

/** The line over the diff: the path on the left, then `patch N of M` and the kind of the newest change. */
function DiffHeader({ file, shown, width }: { file: FileEntry; shown: number; width: number }) {
  const info = `patch ${shown + 1} of ${file.patches.length}  ${file.change}`
  const pathWidth = Math.max(1, width - GAP - Bun.stringWidth(info))
  return (
    <text fg={color.linen} wrapMode="none" flexShrink={0}>
      {padWidth(cutStart(file.rel, pathWidth), pathWidth)}
      <span fg={color.muted}>{' '.repeat(GAP) + info}</span>
    </text>
  )
}

/** One muted line in place of the diff. */
function Note({ text }: { text: string }) {
  return (
    <text fg={color.muted} flexShrink={0}>
      {text}
    </text>
  )
}

/** The diff of the patch that shows, or a line that tells why there is no diff. */
function PatchBody({ file, shown, syntaxStyle }: { file: FileEntry; shown: number; syntaxStyle: SyntaxStyle }) {
  const text = file.patches[shown].patch
  const isDelete = shown === file.patches.length - 1 && file.change === 'deleted'
  if (isDelete) return <Note text={DELETED} />
  if (text === undefined || text === '') return <Note text={NO_DIFF} />
  // `<diff>` draws nothing for a patch without a hunk, and it keeps the
  // view of the patch before. So this text shows instead.
  if (!HUNK_HEADER.test(text)) return <Note text={NO_LINE_CHANGED} />
  return (
    <diff
      // A new view for each patch, so that the scroll of the old patch does not stay.
      key={`${file.rel}\n${shown}`}
      diff={text}
      view="unified"
      filetype={pathToFiletype(file.rel)}
      syntaxStyle={syntaxStyle}
      fg={color.linen}
      wrapMode="word"
      showLineNumbers
      lineNumberFg={color.faint}
      addedBg={color.woadBg}
      removedBg={color.madderBg}
      addedLineNumberBg={color.woadBg}
      removedLineNumberBg={color.madderBg}
      addedSignColor={color.woad}
      removedSignColor={color.madder}
      flexGrow={1}
    />
  )
}

/**
 * The changes pane: the files that the session changed, and the diff of
 * one of them. It draws in exactly `width` x `height` cells, with no border
 * and no title. From the top:
 *
 * - The file list, in the order of the first change. Each row has the path
 *   (cut from the left with `…`), a bar of `▮` that grows with the lines,
 *   and `+N −N` for all the patches of the file. The list has at most 6
 *   rows, and at most a third of the pane. It scrolls to keep the selected
 *   file in view.
 * - A rule, then the path of the selected file, `patch N of M`, and the kind
 *   of its newest change.
 * - The diff of the patch, with line numbers, in the rest of the pane. The
 *   mouse wheel scrolls it. A deleted file shows `deleted`, and a patch
 *   without diff text shows `no diff for this file`.
 *
 * The selection follows the file of the newest change, and shows its newest
 * patch. These keys work only while `focused` is true:
 *
 * - ↑↓ pick a file. Then the selection stays on that file.
 * - `f` follows the newest change again.
 * - `[` and `]` step to the older and the newer patch of the file. While the
 *   user is on an older patch, a new patch of the file does not move the
 *   view. When another file shows, the view goes back to the newest patch.
 *
 * @param state The changed files, from `ChangesWatch.get()`.
 * @param width The cells of a row.
 * @param height The rows of the pane.
 * @param focused True while the pane takes the keys.
 * @param syntaxStyle The colors of the code, from `createSyntaxStyle(renderer)`.
 *   The pane does not destroy it. Destroy it after the pane is gone.
 * @example
 * const state = useSyncExternalStore(changes.subscribe, changes.get)
 * return <Changes state={state} width={64} height={30} focused={pane === 'changes'} syntaxStyle={syntaxStyle} />
 */
export function Changes({ state, width, height, focused, syntaxStyle }: {
  state: ChangesState
  width: number
  height: number
  focused: boolean
  syntaxStyle: SyntaxStyle
}) {
  const choice = useKeyState(FOLLOW)

  useKeyboard((key) => {
    if (!focused) return
    // Keys can come faster than React draws, so the handler reads the choice of the moment.
    const current = choice.now()
    const file = shownFileOf(state, current)
    if (file === undefined) return
    const { files } = state
    const at = files.indexOf(file)
    switch (key.name) {
      case 'up':
        choice.set({ ...current, file: files[Math.max(0, at - 1)].rel })
        return
      case 'down':
        choice.set({ ...current, file: files[Math.min(files.length - 1, at + 1)].rel })
        return
    }
    const shown = shownPatchOf(file, current)
    const newest = file.patches.length - 1
    switch (typedText(key)) {
      case 'f':
        choice.set(FOLLOW)
        return
      case '[':
        if (shown > 0) choice.set({ ...current, step: { file: file.rel, index: shown - 1 } })
        return
      case ']': {
        if (shown === newest) return
        // On the newest patch, the view shows each new patch again.
        const step = shown + 1 === newest ? undefined : { file: file.rel, index: shown + 1 }
        choice.set({ ...current, step })
        return
      }
    }
  })

  const file = shownFileOf(state, choice.value)
  const shownRel = file?.rel
  useEffect(() => {
    // A step counts only for its own file. When another file shows, the step ends.
    const current = choice.now()
    const isStale = current.step !== undefined && current.step.file !== shownRel
    if (isStale) choice.set({ file: current.file })
  }, [shownRel])

  if (file === undefined) {
    return (
      <box width={width} height={height} overflow="hidden">
        <Note text={NO_CHANGES} />
      </box>
    )
  }
  const { files } = state
  const selected = files.indexOf(file)
  const rows = listRowsFor(files.length, height)
  const start = windowStart(files.length, selected, rows)
  const columns = columnsFor(files, width)
  const shown = shownPatchOf(file, choice.value)
  return (
    <box flexDirection="column" width={width} height={height} overflow="hidden">
      <box flexDirection="column" height={rows} flexShrink={0}>
        {files.slice(start, start + rows).map((entry, offset) => (
          <FileLine key={entry.rel} file={entry} columns={columns} selected={start + offset === selected} />
        ))}
      </box>
      <text fg={color.line} wrapMode="none" flexShrink={0}>
        {'─'.repeat(width)}
      </text>
      <DiffHeader file={file} shown={shown} width={width} />
      <PatchBody file={file} shown={shown} syntaxStyle={syntaxStyle} />
    </box>
  )
}
