import { existsSync } from 'node:fs'
import { NativeImage, TextAttributes, type ImageRenderable, type MouseEvent } from '@opentui/core'
import { useKeyboard, useRenderer } from '@opentui/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Line, Segment } from '../state/timeline'
import { NoFfmpegError, PREVIEW_FPS, readFrames } from '../video'
import { isEnter, isPlain, useKeyState } from './keys'
import { color, glyph } from './theme'

/** The frames of the spinner. */
const FRAMES = Array.from(glyph.spinner)

/** The timeline model puts the first frame in a line for each spinner. The pane draws the frame of the moment. */
const SPINNER = FRAMES[0]

/** The time of one spinner frame. */
const FRAME_MS = 90

/** The lines that one step of the mouse wheel scrolls. */
const WHEEL_LINES = 3

/** The lines of one row, from `first` to `last`. */
interface Span {
  id: string
  first: number
  last: number
}

/** Where the window is. */
type Scroll =
  | { follow: true }
  | {
      follow: false
      /** The first line in the window, for when no line has the row `anchor` any more. */
      top: number
      /** The row of the first line in the window. The window stays on this line when lines come or go above it. */
      anchor: string
      /** The lines of the row `anchor` above the window. */
      offset: number
      /** The number of lines when the window stopped following. The lines after them are new. */
      seen: number
    }

/** The window shows the last lines, so new lines come into view. */
const FOLLOW: Scroll = { follow: true }

/** `value`, but at least `min` and at most `max`. */
function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max))
}

/** The rows of the lines, in line order. The lines of one row come one after the other. */
function spansOf(lines: ReadonlyArray<Line>) {
  const spans: Array<Span> = []
  lines.forEach((line, index) => {
    const last = spans.at(-1)
    if (last?.id === line.rowId) last.last = index
    else spans.push({ id: line.rowId, first: index, last: index })
  })
  return spans
}

/** The index of the row that has line `index`. */
function rowOfLine(spans: ReadonlyArray<Span>, index: number) {
  return spans.findIndex((span) => span.last >= index)
}

/** The first line of the window when it shows the last lines. */
function bottomOf(count: number, height: number) {
  return Math.max(0, count - height)
}

/** The first line in the window. */
function topOf(scroll: Scroll, lines: ReadonlyArray<Line>, height: number) {
  const bottom = bottomOf(lines.length, height)
  if (scroll.follow) return bottom
  const { anchor, offset, top } = scroll
  const start = lines.findIndex((line) => line.rowId === anchor)
  return clamp(start === -1 ? top : start + offset, 0, bottom)
}

/**
 * The scroll state of a window that starts at line `top`. A window at the
 * last lines follows them.
 *
 * @param seen The value of `seen` when the window does not follow.
 */
function scrollAt(top: number, lines: ReadonlyArray<Line>, height: number, seen: number) {
  if (top >= bottomOf(lines.length, height)) return FOLLOW
  const anchor = lines[top].rowId
  const start = lines.findIndex((line) => line.rowId === anchor)
  const scroll: Scroll = { follow: false, top, anchor, offset: top - start, seen }
  return scroll
}

/** The first line of a window that shows `span`, as near to `top` as it can be. A row that is taller than the window starts at the top. */
function topToShow(span: Span, top: number, height: number) {
  if (span.first < top) return span.first
  if (span.last < top + height) return top
  return Math.min(span.first, span.last - height + 1)
}

/** The new lines under the window: the lines that came after the window stopped following. */
function newCount(scroll: Scroll, count: number, end: number) {
  if (scroll.follow) return 0
  return Math.max(0, Math.min(count - scroll.seen, count - end))
}

/** The lines that a wheel event scrolls: less than 0 is up. */
function wheelLines(event: MouseEvent) {
  switch (event.scroll?.direction) {
    case 'up':
      return -WHEEL_LINES
    case 'down':
      return WHEEL_LINES
    default:
      return 0
  }
}

/** True when the line has a spinner. */
function hasSpinner(line: Line) {
  return line.segments.some((segment) => segment.text === SPINNER)
}

/** The OpenTUI text attributes of a segment: bold, dim, and italic. */
function attributesOf(segment: Segment) {
  return (
    (segment.bold ? TextAttributes.BOLD : 0) |
    (segment.dim ? TextAttributes.DIM : 0) |
    (segment.italic ? TextAttributes.ITALIC : 0)
  )
}

/** One line of the window. The selected row has the quiet background. */
function LineView({ line, selected, spinner }: { line: Line; selected: boolean; spinner: string }) {
  return (
    <box height={1} flexShrink={0} backgroundColor={selected ? color.selectedBg : 'transparent'}>
      <text fg={color.linen} wrapMode="none">
        {line.segments.map((segment, index) => (
          <span key={index} fg={segment.fg} bg={segment.bg} attributes={attributesOf(segment)}>
            {segment.text === SPINNER ? spinner : segment.text}
          </span>
        ))}
      </text>
    </box>
  )
}

/** A preview in the window: the row, the file, and its lines in the window. */
interface Shown {
  rowId: string
  kind: 'image' | 'video'
  path: string
  /** The cells before the preview. */
  left: number
  /** The first line of the preview in the window. */
  top: number
  /** The lines of the preview in the window. */
  lines: number
}

/** Where a preview draws in the pane, in cells. */
interface Place {
  top: number
  left: number
  width: number
  height: number
}

/** The previews in the window. A preview that is partly out of the window has fewer lines. */
function previewsOf(shown: ReadonlyArray<Line>) {
  const previews: Array<Shown> = []
  shown.forEach((line, index) => {
    if (line.preview === undefined) return
    const last = previews.at(-1)
    if (last?.rowId === line.rowId && last.top + last.lines === index) last.lines += 1
    else previews.push({ rowId: line.rowId, ...line.preview, top: index, lines: 1 })
  })
  return previews
}

/**
 * A picture over its lines, at the left: an image file, or one frame of a
 * video. It keeps its shape, and fits in `width` × `height` cells. OpenTUI
 * draws it with the kitty or sixel graphics of the terminal, else with
 * colored blocks.
 */
function Picture({ source, top, left, width, height, onError }: Place & {
  source: string | NativeImage
  onError?: () => void
}) {
  const picture = useRef<ImageRenderable>(null)
  const [isLoaded, setLoaded] = useState(false)
  // The picture draws in the middle of its box, so the box gets the width of the picture.
  const cells = isLoaded && picture.current !== null ? picture.current.getFittedSize(width, height).width : width
  return (
    <box position="absolute" top={top} left={left} width={cells} height={height}>
      <image
        ref={picture}
        source={source}
        width={cells}
        height={height}
        onLoad={() => setLoaded(true)}
        onError={onError}
      />
    </box>
  )
}

/** A muted note on the first line of a preview, for example when the file is gone. */
function PreviewNote({ text, top, left }: { text: string; top: number; left: number }) {
  return (
    <box position="absolute" top={top} left={left} height={1}>
      <text fg={color.muted} wrapMode="none">{text}</text>
    </box>
  )
}

/** The note of a preview whose file was deleted. */
const GONE = 'The file is gone.'

/** The image file `path` over its lines. */
function ImagePreview({ path, ...place }: Place & { path: string }) {
  const [isBroken, setBroken] = useState(false)
  if (!existsSync(path)) return <PreviewNote text={GONE} top={place.top} left={place.left} />
  if (isBroken) return <PreviewNote text="heddle could not read the image." top={place.top} left={place.left} />
  return <Picture source={path} {...place} onError={() => setBroken(true)} />
}

/**
 * The video file `path` over its lines. When it comes into the window,
 * ffmpeg reads its frames. Then it plays them in a loop, with no sound, until
 * it leaves the window. Without ffmpeg, it says how to get a preview.
 */
function VideoPreview({ path, ...place }: Place & { path: string }) {
  const renderer = useRenderer()
  const [video, setVideo] = useState<{ frames: Array<NativeImage> } | { note: string }>({
    note: 'Reading the video…',
  })
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    let frames: Array<NativeImage> = []
    readFrames(path, abort.signal).then(
      (read) => {
        if (abort.signal.aborted) return
        frames = read.frames.map((pixels) => NativeImage.fromRgba(pixels, read.width, read.height))
        setVideo(frames.length > 0 ? { frames } : { note: 'The video has no frames.' })
      },
      (error: unknown) => {
        if (abort.signal.aborted) return
        setVideo({ note: error instanceof NoFfmpegError ? error.message : 'heddle could not read the video.' })
      },
    )
    return () => {
      abort.abort()
      for (const each of frames) each.dispose()
    }
  }, [path])
  const count = 'frames' in video ? video.frames.length : 0
  useEffect(() => {
    if (count < 2) return
    const timer = renderer.clock.setInterval(() => setFrame((current) => (current + 1) % count), 1000 / PREVIEW_FPS)
    return () => renderer.clock.clearInterval(timer)
  }, [count, renderer])
  const current = 'frames' in video ? video.frames[frame % count] : undefined
  if (!existsSync(path)) return <PreviewNote text={GONE} top={place.top} left={place.left} />
  if (current === undefined) {
    const note = 'note' in video ? video.note : 'The video has no frames.'
    return <PreviewNote text={note} top={place.top} left={place.left} />
  }
  return <Picture source={current} {...place} />
}

/** `↓ 3 new` at the bottom right of the pane. */
function NewLines({ count }: { count: number }) {
  return (
    <box position="absolute" bottom={0} right={0}>
      <text fg={color.indigo} bg={color.loom} wrapMode="none">
        {` ↓ ${count} new`}
      </text>
    </box>
  )
}

/**
 * The timeline pane. It draws only the `height` lines of its window.
 *
 * Scrolling:
 *
 * - The window follows the bottom, so new lines come into view.
 * - When the user scrolls up, the window stops. It stays on the same lines
 *   when lines come under it or above it. `↓ N new` shows how many lines came
 *   under it.
 * - When the window gets back to the last lines, it follows them again.
 * - The mouse wheel scrolls 3 lines, also while the pane is not focused.
 *
 * Keys, only while `focused` is true:
 *
 * - ↑↓ select the row above or below. With no row selected, they select the
 *   last row in the window. The window scrolls to show the selected row.
 * - pageup and pagedown scroll one page. When the selected row goes out of
 *   the window, the nearest row in the window becomes the selected row.
 * - home selects the first row. end selects the last row, and the window
 *   follows the bottom again.
 * - enter calls `onOpen` with the selected row. With no row selected, it does
 *   nothing.
 *
 * The pane calls `preventDefault()` on each key that it uses. The other
 * `useKeyboard` handlers still get the key.
 *
 * The selected row has a quiet background, also while the pane is not
 * focused. The selection is a row id, so it stays on its row when lines
 * change. When no line has the selected row any more, no row is selected.
 *
 * A line with `preview` has its part of the preview of an image or a video.
 * The pane draws the file over the lines of its row that are in the window.
 * A video plays in a loop while it is in the window.
 *
 * A spinner (a segment with the text `glyph.spinner.charAt(0)`) turns while
 * `live` is true. One 90 ms timer of the renderer clock runs, only while
 * `live` is true and a spinner is in the window.
 *
 * The scroll state and the selection are in the pane. To start again at the
 * bottom, for example for another session, give the pane a new `key`.
 *
 * @param lines The lines from `layoutLines(rows, width)`. Give the same array
 *   until the rows change.
 * @param width The width of the pane, in cells. The lines must not be wider.
 * @param height The number of lines that the pane shows.
 * @param focused True while the pane takes the keys.
 * @param live True while the session runs. The spinners turn only then.
 * @param selectedRowId The row to select. The pane selects it each time this
 *   value changes, and the keys move the selection from there.
 * @param onSelect Called with the id of the new selected row each time the
 *   keys move the selection.
 * @param onOpen Called with the id of the selected row on enter.
 * @example
 * const lines = useMemo(() => layoutLines(rows, width), [rows, width])
 * <Timeline
 *   lines={lines}
 *   width={width}
 *   height={height}
 *   focused={focus === 'timeline'}
 *   live={isRunning}
 *   selectedRowId={selectedRowId}
 *   onSelect={setSelectedRowId}
 *   onOpen={openRow}
 * />
 */
export function Timeline({
  lines,
  width,
  height,
  focused,
  live,
  selectedRowId,
  onSelect,
  onOpen,
}: {
  lines: ReadonlyArray<Line>
  width: number
  height: number
  focused: boolean
  live: boolean
  selectedRowId?: string
  onSelect(rowId: string): void
  onOpen(rowId: string): void
}) {
  const renderer = useRenderer()
  const spans = useMemo(() => spansOf(lines), [lines])
  const scroll = useKeyState(FOLLOW)
  const selected = useKeyState(selectedRowId)
  // A new `selectedRowId` selects its row. Keys can then move the selection away from it.
  const [givenId, setGivenId] = useState(selectedRowId)
  if (givenId !== selectedRowId) {
    setGivenId(selectedRowId)
    selected.set(selectedRowId)
  }
  const [frame, setFrame] = useState(0)

  /** Moves the window to start at line `top`. */
  const moveTo = (top: number) => {
    const before = scroll.now()
    const seen = before.follow ? lines.length : before.seen
    scroll.set(scrollAt(top, lines, height, seen))
  }

  /** Selects the row at `index` of `spans`, and tells the parent. */
  const choose = (index: number) => {
    const id = spans[index].id
    if (id === selected.now()) return
    selected.set(id)
    onSelect(id)
  }

  useKeyboard((key) => {
    if (!focused || !isPlain(key) || spans.length === 0) return
    const top = topOf(scroll.now(), lines, height)
    const bottom = bottomOf(lines.length, height)
    const lastInView = Math.min(top + height, lines.length) - 1
    const index = spans.findIndex((span) => span.id === selected.now())
    if (isEnter(key)) {
      if (index === -1) return
      key.preventDefault()
      onOpen(spans[index].id)
      return
    }
    switch (key.name) {
      case 'up':
      case 'down': {
        key.preventDefault()
        const step = key.name === 'up' ? -1 : 1
        const next = index === -1 ? rowOfLine(spans, lastInView) : clamp(index + step, 0, spans.length - 1)
        choose(next)
        moveTo(topToShow(spans[next], top, height))
        return
      }
      case 'pageup':
      case 'pagedown': {
        key.preventDefault()
        const page = Math.max(1, height - 1)
        const next = clamp(key.name === 'pageup' ? top - page : top + page, 0, bottom)
        moveTo(next)
        if (index === -1) return
        const span = spans[index]
        if (span.last < next) choose(rowOfLine(spans, next))
        else if (span.first >= next + height) choose(rowOfLine(spans, Math.min(next + height, lines.length) - 1))
        return
      }
      case 'home':
        key.preventDefault()
        choose(0)
        moveTo(0)
        return
      case 'end':
        key.preventDefault()
        choose(spans.length - 1)
        moveTo(bottom)
        return
    }
  })

  const onWheel = (event: MouseEvent) => {
    const step = wheelLines(event)
    if (step === 0) return
    const top = topOf(scroll.now(), lines, height)
    moveTo(clamp(top + step, 0, bottomOf(lines.length, height)))
  }

  const top = topOf(scroll.value, lines, height)
  const shown = lines.slice(top, top + height)
  const isSpinning = live && shown.some(hasSpinner)
  useEffect(() => {
    if (!isSpinning) return
    const { clock } = renderer
    const timer = clock.setInterval(() => setFrame((current) => (current + 1) % FRAMES.length), FRAME_MS)
    return () => clock.clearInterval(timer)
  }, [isSpinning, renderer])

  const spinner = FRAMES[live ? frame : 0]
  const fresh = newCount(scroll.value, lines.length, top + height)
  return (
    <box width={width} height={height} flexDirection="column" flexShrink={0} onMouseScroll={onWheel}>
      {shown.map((line, index) => (
        // The key is the place in the window, so a scroll changes the text and keeps the boxes.
        <LineView key={index} line={line} selected={line.rowId === selected.value} spinner={spinner} />
      ))}
      {previewsOf(shown).map(({ rowId, kind, path, top, left, lines: count }) => {
        const place = { top, left, width: Math.max(1, width - left), height: count }
        return kind === 'image' ? (
          <ImagePreview key={rowId} path={path} {...place} />
        ) : (
          <VideoPreview key={rowId} path={path} {...place} />
        )
      })}
      {fresh > 0 ? <NewLines count={fresh} /> : null}
    </box>
  )
}
