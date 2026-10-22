// The timeline model. It turns the messages of a session view into rows, and
// the rows into screen lines. It has no UI code and does no I/O.
import type {
  AgentPart,
  NoticeKind,
  ToolCallPart,
  ToolCallStatus,
  ViewMessage,
  ViewPart,
} from '@tanstack/ai-harness/view'
import { color, glyph } from '../ui/theme'
import { graphemes, isRecord, relativePath } from '../utils'
import { markdownSegments } from './markdown'

/** One item of the timeline. */
export interface Row {
  /** The message, part, or tool call id (stable). */
  id: string
  kind:
    | 'user'
    | 'assistant'
    | 'tool'
    | 'program'
    | 'agent-start'
    | 'agent-end'
    | 'notice'
    | 'error'
    | 'reasoning'
  /** 0 = the lead agent, 1 or more = subagents. */
  depth: number
  /** 'you', the model name, the tool label, or the agent name. */
  title: string
  /** The message text, the tool target, or the agent task or result. */
  text: string
  status?: 'running' | 'done' | 'failed' | 'waiting'
  /** Tools: ◆ when true, ◇ when false. */
  write?: boolean
  additions?: number
  deletions?: number
  /** Agent rows: the AgentPart id, for `view.loadAgent`. */
  agentId?: string
  /** Program rows: the program text. */
  code?: string
}

/** Text with one style. The colors are hex values from `color`. */
export interface Segment {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
}

/** One screen line. `rowId` is the id of the row that the line shows. */
export interface Line {
  rowId: string
  segments: Array<Segment>
}

export interface RowOptions {
  /** The title of the text rows of the lead, for example `opus`. */
  model: string
  /** The tools root. Tool rows show their paths relative to it. */
  root: string
  /** The `+N −N` of the file changes of each tool call, by tool call id. */
  counts?: ReadonlyMap<string, { additions: number; deletions: number }>
}

// Rows

/** The tools that can change files. Their rows show ◆. */
const WRITE_TOOLS = ['write_file', 'edit_file', 'patch', 'bash']

/** The code mode tool. Its call shows as one program row. */
const PROGRAM_TOOL = 'execute_typescript'

/** A program that calls a write tool, such as `external_edit_file`, can change files too. */
const PROGRAM_WRITES = new RegExp(
  `\\bexternal_(?:${WRITE_TOOLS.join('|')})\\b`,
)

/** The short labels of the coding tools. The other tools keep their names. */
const LABELS = new Map([
  ['read_file', 'read'],
  ['edit_file', 'edit'],
  ['write_file', 'write'],
  ['list_files', 'list'],
])

/** The row status of a tool call. A call that waits for an approval is `waiting`. */
const STATUS = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  'needs-approval': 'waiting',
} satisfies Record<ToolCallStatus, Row['status']>

/** The notices that tell of a failure. They show as error rows. */
const ERROR_NOTICES: ReadonlyArray<NoticeKind> = ['error', 'rejected']

/** A file line of a patch, such as `*** Update File: src/a.ts`. */
const PATCH_FILE =
  /^\*\*\* (?:Add File|Update File|Delete File|Move to):(.*)$/gm

/** What a list of parts belongs to. */
interface Scope {
  /** The depth of the rows. A child agent goes one depth deeper. */
  depth: number
  /** The title of the text rows: the model or the agent name. */
  speaker: string
  /** The message or agent id. A text part has no id, so its row id starts with this one. */
  owner: string
  /** Text parts show as rows. In a branch, only the end row shows the last text. */
  showText: boolean
}

/** The string at `key` of a JSON value, such as the arguments of a tool call. */
function stringAt(value: unknown, key: string) {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === 'string' ? field : undefined
}

/** What a tool call works on: a path, a search, the files of a patch, a command, or a URL. */
function targetOf(args: unknown, root: string) {
  const path = stringAt(args, 'path')
  const where = path === undefined ? undefined : relativePath(path, root)
  const pattern = stringAt(args, 'pattern')
  if (pattern !== undefined) {
    return where === undefined ? `"${pattern}"` : `"${pattern}" in ${where}`
  }
  if (where !== undefined) return where
  const patch = stringAt(args, 'patch')
  if (patch !== undefined) {
    const files = [...patch.matchAll(PATCH_FILE)]
    return files
      .map((match) => relativePath(match[1].trim(), root))
      .join(', ')
  }
  return (
    stringAt(args, 'command') ??
    stringAt(args, 'url') ??
    stringAt(args, 'query') ??
    ''
  )
}

/** The first line of a program that has text, without a `//` in front. */
function programSummary(code: string) {
  const lines = code.split('\n')
  const first = lines.find((line) => line.trim() !== '') ?? ''
  return first.trim().replace(/^\/\/\s*/, '')
}

function toolRow(call: ToolCallPart, depth: number, options: RowOptions) {
  const counts = options.counts?.get(call.id)
  const row: Row = {
    id: call.id,
    kind: 'tool',
    depth,
    title: LABELS.get(call.name) ?? call.name,
    text: targetOf(call.args, options.root),
    status: STATUS[call.status],
    write: WRITE_TOOLS.includes(call.name),
    additions: counts?.additions,
    deletions: counts?.deletions,
  }
  return row
}

function programRow(call: ToolCallPart, depth: number, options: RowOptions) {
  // The arguments are there only after the model ends the call.
  const code = stringAt(call.args, 'typescriptCode') ?? ''
  const counts = options.counts?.get(call.id)
  const row: Row = {
    id: call.id,
    kind: 'program',
    depth,
    title: 'program',
    text: programSummary(code),
    status: STATUS[call.status],
    write: PROGRAM_WRITES.test(code),
    additions: counts?.additions,
    deletions: counts?.deletions,
    code,
  }
  return row
}

/**
 * The tool call that started each child agent of `parts`, by agent id. An
 * agent tool has the name of its agent, and its call comes before the agent
 * part. Some finished calls name their child run. The other agents take the
 * first free call with their name.
 */
function startCalls(parts: ReadonlyArray<ViewPart>) {
  const agentIds = new Set(
    parts.flatMap((part) => (part.type === 'agent' ? [part.id] : [])),
  )
  const calls: Map<string, ToolCallPart> = new Map()
  const free: Array<ToolCallPart> = []
  for (const part of parts) {
    if (part.type === 'tool-call') {
      const child = stringAt(part.result, 'subagentRunId')
      if (child === undefined) free.push(part)
      else if (agentIds.has(child)) calls.set(child, part)
      continue
    }
    if (part.type !== 'agent' || calls.has(part.id)) continue
    const index = free.findIndex((call) => call.name === part.name)
    if (index >= 0) calls.set(part.id, free.splice(index, 1)[0])
  }
  return calls
}

/** The text of the last text part that has text. */
function lastText(parts: ReadonlyArray<ViewPart>) {
  const texts = parts.flatMap((part) =>
    part.type === 'text' && part.text.trim() !== '' ? [part.text.trim()] : [],
  )
  return texts.at(-1)
}

/** What the end row of an agent says: its error, its last text, or its result. */
function endText(agent: AgentPart, call: ToolCallPart | undefined) {
  if (agent.status === 'failed') return agent.error ?? 'failed'
  // After a reload, an agent has no parts until it loads. Its tool call has the result.
  const result =
    typeof agent.result === 'string'
      ? agent.result
      : stringAt(call?.result, 'result')
  return lastText(agent.parts) ?? result?.trim() ?? ''
}

function addAgent(
  rows: Array<Row>,
  agent: AgentPart,
  call: ToolCallPart | undefined,
  depth: number,
  options: RowOptions,
) {
  rows.push({
    id: agent.id,
    kind: 'agent-start',
    depth,
    title: agent.name,
    text: stringAt(call?.args, 'prompt')?.trim() ?? '',
    status: agent.status,
    agentId: agent.id,
  })
  const scope = { depth, speaker: agent.name, owner: agent.id, showText: false }
  addParts(rows, agent.parts, scope, options)
  // The branch of an agent that runs stays open. Its end row comes when it ends.
  if (agent.status === 'running') return
  rows.push({
    id: `${agent.id}:end`,
    kind: 'agent-end',
    depth,
    title: agent.name,
    text: endText(agent, call),
    status: agent.status,
    agentId: agent.id,
  })
}

function addParts(
  rows: Array<Row>,
  parts: ReadonlyArray<ViewPart>,
  scope: Scope,
  options: RowOptions,
) {
  const starts = startCalls(parts)
  const startIds = new Set(Array.from(starts.values(), (call) => call.id))
  for (const [index, part] of parts.entries()) {
    switch (part.type) {
      case 'text': {
        const text = part.text.trim()
        if (!scope.showText || text === '') break
        rows.push({
          id: `${scope.owner}:${index}`,
          kind: 'assistant',
          depth: scope.depth,
          title: scope.speaker,
          text,
        })
        break
      }
      case 'tool-call':
        // The call that started an agent shows as the branch of that agent.
        if (startIds.has(part.id)) break
        rows.push(
          part.name === PROGRAM_TOOL
            ? programRow(part, scope.depth, options)
            : toolRow(part, scope.depth, options),
        )
        break
      case 'agent':
        addAgent(rows, part, starts.get(part.id), scope.depth + 1, options)
        break
      case 'reasoning': {
        const text = part.text.trim()
        if (!scope.showText || text === '') break
        rows.push({ id: `${scope.owner}:${index}`, kind: 'reasoning', depth: scope.depth, title: 'thinking', text })
        break
      }
      case 'media':
        break
    }
  }
}

/**
 * Makes the timeline rows of a session from its view messages.
 *
 * - A child agent is a branch: an `agent-start` row with its task, the rows
 *   of its tool calls one depth deeper, and an `agent-end` row with its
 *   result when it ends. The tool call that started it has no row.
 * - A code mode program is one `program` row. `code` has its text.
 * - A tool call that waits for an approval has the status `waiting`.
 * - The reasoning of a model is a `reasoning` row. `layoutLines` shows it in
 *   muted italic, and shows the answers as markdown.
 *
 * @param messages The messages of the view state.
 * @param options The model name, the tools root, and the line counts of the
 *   tool calls.
 * @example
 * const rows = buildRows(view.store.get().messages, { model: 'opus', root, counts })
 */
export function buildRows(
  messages: ReadonlyArray<ViewMessage>,
  options: RowOptions,
) {
  const rows: Array<Row> = []
  for (const message of messages) {
    switch (message.role) {
      case 'user':
        rows.push({
          id: message.id,
          kind: 'user',
          depth: 0,
          title: 'you',
          text: message.text.trim(),
        })
        break
      case 'assistant': {
        const scope = {
          depth: 0,
          speaker: message.agent ?? options.model,
          owner: message.id,
          showText: true,
        }
        addParts(rows, message.parts, scope, options)
        break
      }
      case 'notice':
        rows.push({
          id: message.id,
          kind: ERROR_NOTICES.includes(message.kind) ? 'error' : 'notice',
          depth: 0,
          title: '',
          text: message.text.trim(),
        })
        break
    }
  }
  return rows
}

/**
 * Makes the rows of the transcript of one child agent, for the pane that
 * shows it. Its text rows have the agent name as their title, and its own
 * children are branches. A failed agent ends with an error row.
 *
 * @param agent The agent part, after `view.loadAgent({ id })` filled it.
 * @param options The same options as for `buildRows`.
 * @example
 * await view.loadAgent({ id: agent.id })
 * const rows = buildAgentRows(agent, { model: 'opus', root })
 */
export function buildAgentRows(agent: AgentPart, options: RowOptions) {
  const rows: Array<Row> = []
  const scope = { depth: 0, speaker: agent.name, owner: agent.id, showText: true }
  addParts(rows, agent.parts, scope, options)
  if (agent.status === 'failed') {
    rows.push({
      id: `${agent.id}:error`,
      kind: 'error',
      depth: 0,
      title: '',
      text: agent.error ?? 'failed',
    })
  }
  return rows
}

/**
 * What a running turn does now, for the line at the end of the timeline:
 * `Starting` before its first model output (the harness takes a snapshot of
 * the files first, which can take long in a big folder), `Thinking` while the
 * model reasons, and `Working` after that.
 *
 * @param messages The messages of the view state.
 * @example
 * layoutLines(rows, width, isRunning ? activityOf(messages) : undefined)
 */
export function activityOf(messages: ReadonlyArray<ViewMessage>) {
  const lastSent = messages.findLastIndex((message) => message.role === 'user')
  const reply = messages.slice(lastSent + 1).findLast((message) => message.role === 'assistant')
  if (reply?.role !== 'assistant' || reply.parts.length === 0) return 'Starting'
  return reply.parts.at(-1)?.type === 'reasoning' ? 'Thinking' : 'Working'
}

// Lines

/** The style of a segment: all of it but the text. */
type Style = Omit<Segment, 'text'>

/** How one row draws: a mark in its lane, a head, the text, and a tail at the right end. */
interface Block {
  /** `●` for a message or an agent, the spine for the other rows. */
  mark: Segment
  /** The title or the tool label, before the text on the first line. */
  head: Array<Segment>
  text: Array<Segment>
  /** The counts and the status, at the right end of the last line. */
  tail: Array<Segment>
  /** The lines after the first start under the text, not under the head. */
  hang: boolean
}

/** The cells between the lane and the row. */
const GAP = '  '
/** The cells between a title and its text. */
const TITLE_GAP = '   '
/** A tool label (`◇ read`) takes at least this many cells, so the targets line up. */
const LABEL_CELLS = 9
/** The lines after the first hang under the text only when they keep this many cells. */
const MIN_HANG = 10
/** The cells at least between the text and the tail on one line. */
const TAIL_GAP = 2
/** The first spinner frame. The timeline pane swaps it for the frame of the moment. */
const SPINNER = glyph.spinner.charAt(0)

/** The display width of the segments, in terminal cells. */
function widthOf(segments: ReadonlyArray<Segment>) {
  return segments.reduce(
    (cells, segment) => cells + Bun.stringWidth(segment.text),
    0,
  )
}

/** The text as a terminal can show it: tabs become spaces, and control characters go. */
function clean(text: string) {
  return text
    .replace(/\r\n?/g, '\n')
    .replaceAll('\t', '  ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

/** The spine style of the lane at `depth`: indigo for the lead, a dim lavender for a subagent. */
function spineStyle(depth: number) {
  return depth === 0
    ? { fg: color.indigoDim }
    : { fg: color.lavender, dim: true }
}

/** The lanes of the parents of `depth`, as `│ ` for each one. */
function lanes(depth: number) {
  const segments: Array<Segment> = []
  for (let lane = 0; lane < depth; lane += 1) {
    segments.push({ text: glyph.spine, ...spineStyle(lane) }, { text: ' ' })
  }
  return segments
}

/** A line with only the lane at `depth`: the spine for a blank line, or `┊` for a lane that goes on. */
function laneLine(depth: number, mark: string) {
  return [...lanes(depth), { text: mark, ...spineStyle(depth) }]
}

/** The line where the branch at `depth` leaves its parent lane (`├─╮`) or joins it again (`├─╯`). */
function branchLine(depth: number, mark: string) {
  return [
    ...lanes(depth - 1),
    { text: mark.slice(0, -1), ...spineStyle(depth - 1) },
    { text: mark.slice(-1), ...spineStyle(depth) },
  ]
}

/** The line without the spaces at its end. */
function trimEnd(line: ReadonlyArray<Segment>) {
  const trimmed = [...line]
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1]
    const text = last.text.replace(/ +$/, '')
    if (text !== '') {
      trimmed[trimmed.length - 1] = { ...last, text }
      break
    }
    trimmed.pop()
  }
  return trimmed
}

/**
 * Wraps the segments into lines of `first` cells, and `rest` cells after the
 * first line. A line breaks at a space. A word that is wider than a line
 * breaks between its characters. A CJK character or an emoji takes 2 cells.
 */
function wrap(segments: ReadonlyArray<Segment>, first: number, rest: number) {
  const lines: Array<Array<Segment>> = [[]]
  let used = 0
  // The segment that the end of the line comes from. Its next text joins it.
  let source: Segment | undefined
  let isEmpty = true
  const limit = () => (lines.length === 1 ? first : rest)
  const newLine = () => {
    lines.push([])
    used = 0
    source = undefined
  }
  const put = (from: Segment, text: string, cells: number) => {
    const line = lines[lines.length - 1]
    const last = line.at(-1)
    if (source === from && last !== undefined) last.text += text
    else line.push({ ...from, text })
    source = from
    used += cells
  }
  for (const segment of segments) {
    const tokens = segment.text.match(/\n| +|[^ \n]+/g) ?? []
    for (const token of tokens) {
      isEmpty = false
      if (token === '\n') {
        newLine()
        continue
      }
      const cells = Bun.stringWidth(token)
      if (used + cells <= limit()) {
        put(segment, token, cells)
        continue
      }
      // The spaces where a line breaks do not show.
      if (token.startsWith(' ')) continue
      if (cells <= rest && used > 0) {
        newLine()
        put(segment, token, cells)
        continue
      }
      const characters = graphemes(token)
      for (const character of characters) {
        const size = Bun.stringWidth(character)
        if (used + size > limit() && used > 0) newLine()
        put(segment, character, size)
      }
    }
  }
  return isEmpty ? [] : lines.map(trimEnd)
}

/** Puts `tail` at the right end of the last line, or on a new line when it does not fit. */
function withTail(
  lines: Array<Array<Segment>>,
  tail: ReadonlyArray<Segment>,
  room: number,
) {
  if (tail.length === 0) return lines
  const tailCells = widthOf(tail)
  const last = lines.at(-1)
  const fits =
    last !== undefined && widthOf(last) + TAIL_GAP + tailCells <= room
  const before = fits ? last : []
  const pad = Math.max(room - widthOf(before) - tailCells, 0)
  const line = [...before, { text: ' '.repeat(pad) }, ...tail]
  return fits ? [...lines.slice(0, -1), line] : [...lines, line]
}

/** The lines of one row, with the lanes in front. */
function blockLines(depth: number, block: Block, width: number) {
  const lane = { text: glyph.spine, ...spineStyle(depth) }
  const first = [...lanes(depth), block.mark, { text: GAP }]
  const rest = [...lanes(depth), lane, { text: GAP }]
  const room = Math.max(width - widthOf(first), 1)
  const headCells = widthOf(block.head)
  const indent = block.hang && room - headCells >= MIN_HANG ? headCells : 0
  const body = wrap([...block.head, ...block.text], room, room - indent)
  const hung = body.map((segments, index) =>
    index === 0 || indent === 0
      ? segments
      : [{ text: ' '.repeat(indent) }, ...segments],
  )
  const placed = withTail(hung, block.tail, room)
  return placed.map((segments, index) => [
    ...(index === 0 ? first : rest),
    ...segments,
  ])
}

/** The status at the right end of a tool row. The spinner turns while the call runs. */
function statusTail(status: Row['status']) {
  switch (status) {
    case 'running':
      return [{ text: SPINNER, fg: color.indigo }]
    case 'waiting':
      return [
        { text: SPINNER, fg: color.weld },
        { text: ' needs you', fg: color.weld },
      ]
    case 'failed':
      return [{ text: 'failed', fg: color.madder }]
    case 'done':
    case undefined:
      return []
  }
}

/** The right end of a tool row: `+N −N`, then the status. */
function tailOf(row: Row) {
  const groups: Array<Array<Segment>> = []
  if (row.additions) {
    groups.push([{ text: `+${row.additions}`, fg: color.woad }])
  }
  if (row.deletions) {
    groups.push([{ text: `−${row.deletions}`, fg: color.madder }])
  }
  const status = statusTail(row.status)
  if (status.length > 0) groups.push(status)
  return groups.flatMap((group, index) =>
    index === 0 ? group : [{ text: ' ' }, ...group],
  )
}

/** The lines of one row, before the cut to the width. */
function rowLines(row: Row, width: number) {
  const lane = { text: glyph.spine, ...spineStyle(row.depth) }
  const title = clean(row.title)
  const text = clean(row.text)
  switch (row.kind) {
    case 'user': {
      const you: Style = { fg: color.linen, bold: true }
      const header: Block = {
        mark: { text: glyph.dot, ...you },
        head: [{ text: title, ...you }],
        text: [],
        tail: [],
        hang: false,
      }
      const message: Block = {
        mark: lane,
        head: [],
        text: [{ text, fg: color.linen }],
        tail: [],
        hang: false,
      }
      return [
        ...blockLines(row.depth, header, width),
        ...blockLines(row.depth, message, width),
      ]
    }
    case 'assistant':
    case 'agent-start':
    case 'agent-end': {
      const accent: Style = {
        fg: row.depth > 0 ? color.lavender : color.indigo,
        bold: true,
      }
      const isFailed = row.kind === 'agent-end' && row.status === 'failed'
      // The answers of the agents are markdown. A task is plain text.
      const body =
        row.kind === 'agent-start' || isFailed
          ? [{ text, fg: isFailed ? color.madder : color.linen }]
          : markdownSegments(text, color.linen)
      return blockLines(
        row.depth,
        {
          mark: { text: glyph.dot, ...accent },
          head: [{ text: title, ...accent }, { text: TITLE_GAP }],
          text: body,
          tail: [],
          hang: true,
        },
        width,
      )
    }
    case 'tool':
    case 'program': {
      const label = `${row.write ? glyph.write : glyph.read} ${title}`
      const pad = Math.max(LABEL_CELLS - Bun.stringWidth(label), 0)
      return blockLines(
        row.depth,
        {
          mark: lane,
          head: [
            { text: label, fg: row.write ? color.linen : color.muted },
            { text: ' '.repeat(pad) + TITLE_GAP },
          ],
          text: [{ text, fg: color.linen }],
          tail: tailOf(row),
          hang: true,
        },
        width,
      )
    }
    case 'notice':
    case 'error':
      return blockLines(
        row.depth,
        {
          mark: lane,
          head: [],
          text: [
            {
              text,
              fg: row.kind === 'error' ? color.madder : color.muted,
            },
          ],
          tail: [],
          hang: false,
        },
        width,
      )
    case 'reasoning':
      return blockLines(
        row.depth,
        {
          mark: lane,
          head: [{ text: title, fg: color.faint, italic: true }, { text: TITLE_GAP }],
          text: [{ text, fg: color.muted, italic: true }],
          tail: [],
          hang: true,
        },
        width,
      )
  }
}

/** The segments cut to `width` cells, so that no line draws past the edge. */
function fit(segments: ReadonlyArray<Segment>, width: number) {
  const fitted: Array<Segment> = []
  let used = 0
  for (const segment of segments) {
    if (segment.text === '') continue
    const cells = Bun.stringWidth(segment.text)
    if (used + cells <= width) {
      fitted.push({ ...segment })
      used += cells
      continue
    }
    let text = ''
    const characters = graphemes(segment.text)
    for (const character of characters) {
      const size = Bun.stringWidth(character)
      if (used + size > width) break
      text += character
      used += size
    }
    if (text !== '') fitted.push({ ...segment, text })
    break
  }
  return fitted
}

/**
 * Lays the rows out as screen lines that are at most `width` cells wide. Text
 * wraps by display width (`Bun.stringWidth`).
 *
 * - Each depth has its lane: `●` starts a message or an agent, and `│` goes
 *   on. `├─╮` opens the branch of a subagent, and `├─╯` closes it. `┊` ends
 *   a lane that goes on: the lead at the bottom, and a subagent that runs.
 * - The lanes of subagents are lavender. Errors are madder.
 * - A tool row has its `+N −N` and its status at the right end. A spinner is
 *   a segment whose text is `glyph.spinner.charAt(0)`.
 * - Each line has the id of a row. A blank line and a `├─╮` line belong to
 *   the row after them. A `├─╯` line and a `┊` line belong to the row before
 *   them.
 *
 * While a turn runs, the last line is a spinner and `activity`, for example
 * `Thinking…`, in place of the `┊` of the lead lane.
 *
 * @param rows The rows from `buildRows` or `buildAgentRows`.
 * @param width The width of the pane, in cells.
 * @param activity What the running turn does, from `activityOf`.
 * @example
 * const lines = layoutLines(buildRows(messages, options), 48)
 */
export function layoutLines(rows: ReadonlyArray<Row>, width: number, activity?: string) {
  const lines: Array<Line> = []
  if (width < 1 || rows.length === 0) return lines
  const add = (rowId: string, segments: ReadonlyArray<Segment>) => {
    lines.push({ rowId, segments: fit(segments, width) })
  }
  // The depth of the deepest branch that is open. 0 is the lead lane.
  let open = 0
  let lastId = ''
  // A branch with no end row closes with `┊` when a row comes from a lower depth.
  const closeTo = (depth: number) => {
    for (; open > depth; open -= 1) add(lastId, laneLine(open, glyph.more))
  }
  for (const row of rows) {
    const isStart = row.kind === 'agent-start'
    closeTo(isStart ? row.depth - 1 : row.depth)
    if (isStart) {
      add(row.id, branchLine(row.depth, glyph.open))
      open = row.depth
    }
    const isMessage = row.kind === 'user' || row.kind === 'assistant' || row.kind === 'reasoning'
    if (isMessage && lines.length > 0) {
      add(row.id, laneLine(row.depth, glyph.spine))
    }
    const segmentsOfRow = rowLines(row, width)
    for (const segments of segmentsOfRow) add(row.id, segments)
    if (row.kind === 'agent-end') {
      add(row.id, branchLine(row.depth, glyph.close))
      open = row.depth - 1
    }
    lastId = row.id
  }
  closeTo(0)
  // ponytail: no elapsed time. The spinner shows that the turn is alive.
  const end =
    activity === undefined
      ? laneLine(0, glyph.more)
      : [{ text: SPINNER, fg: color.indigo }, { text: GAP }, { text: `${activity}…`, fg: color.muted }]
  add(lastId, end)
  return lines
}
