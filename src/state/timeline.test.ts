import { describe, expect, test } from 'bun:test'
import type {
  AgentPart,
  ToolCallPart,
  ViewMessage,
  ViewPart,
} from '@tanstack/ai-harness/view'
import { color } from '../ui/theme'
import { buildAgentRows, buildRows, layoutLines } from './timeline'
import type { Line, RowOptions } from './timeline'

const options: RowOptions = { model: 'opus', root: 'F:/projects/demo' }

/** A finished tool call. Its id is `call-<name>`, unless `fields` gives one. */
function toolCall(
  name: string,
  args: unknown,
  fields: Partial<ToolCallPart> = {},
) {
  const part: ToolCallPart = {
    type: 'tool-call',
    id: `call-${name}`,
    name,
    argsText: JSON.stringify(args),
    args,
    status: 'done',
    ...fields,
  }
  return part
}

/** A finished child agent named explore. */
function agentPart(
  id: string,
  parts: Array<ViewPart>,
  fields: Partial<AgentPart> = {},
) {
  const part: AgentPart = {
    type: 'agent',
    id,
    name: 'explore',
    status: 'done',
    parts,
    ...fields,
  }
  return part
}

function textPart(text: string) {
  const part: ViewPart = { type: 'text', text }
  return part
}

function assistant(id: string, parts: Array<ViewPart>) {
  const message: ViewMessage = { id, role: 'assistant', parts }
  return message
}

/** The text of each line, without the spaces at its end. */
function plain(lines: ReadonlyArray<Line>) {
  return lines.map((line) =>
    line.segments
      .map((segment) => segment.text)
      .join('')
      .trimEnd(),
  )
}

/** The line whose text starts with `start`. */
function lineAt(lines: ReadonlyArray<Line>, start: string) {
  const line = lines.find((item) =>
    item.segments
      .map((segment) => segment.text)
      .join('')
      .startsWith(start),
  )
  if (!line) throw new Error(`No line starts with "${start}".`)
  return line
}

// The session of the mockup: a question, a program, an explore branch, two
// edits, and a bash call that waits for an approval.
const session: Array<ViewMessage> = [
  { id: 'user-0', role: 'user', text: 'The add test fails. Fix it.\n' },
  assistant('turn-1', [
    { type: 'reasoning', text: 'The test calls add.' },
    textPart('I will read the code and the test.'),
    toolCall('execute_typescript', {
      typescriptCode:
        "// read 2 files\nawait external_read_file({ path: 'src/math.mjs' })",
    }),
    toolCall('explore', { prompt: 'who else calls add()?' }),
    agentPart('run-explore', [
      toolCall('grep', { pattern: 'add(', path: 'F:/projects/demo/src' }),
      toolCall('read_file', { path: 'src/cli.mjs' }),
      textPart('1 caller, nothing to change'),
    ]),
    toolCall(
      'edit_file',
      { path: 'F:/projects/demo/src/math.mjs', old: 'a - b', new: 'a + b' },
      { id: 'call-edit-1' },
    ),
    toolCall(
      'edit_file',
      { path: 'test/math.test.mjs', old: '', new: 'test()' },
      { id: 'call-edit-2' },
    ),
    toolCall('bash', { command: 'node --test' }, { status: 'needs-approval' }),
  ]),
]

const counts = new Map([
  ['call-edit-1', { additions: 1, deletions: 1 }],
  ['call-edit-2', { additions: 6, deletions: 0 }],
])

const sessionRows = buildRows(session, { ...options, counts })

describe('buildRows', () => {
  test('user, reasoning, and assistant rows', () => {
    expect(sessionRows.slice(0, 3)).toEqual([
      {
        id: 'user-0',
        kind: 'user',
        depth: 0,
        title: 'you',
        text: 'The add test fails. Fix it.',
      },
      {
        id: 'turn-1:0',
        kind: 'reasoning',
        depth: 0,
        title: 'thinking',
        text: 'The test calls add.',
      },
      {
        id: 'turn-1:1',
        kind: 'assistant',
        depth: 0,
        title: 'opus',
        text: 'I will read the code and the test.',
      },
    ])
  })

  test('a subagent branches and merges', () => {
    const branch = sessionRows.filter((row) => row.depth === 1)
    expect(branch).toEqual([
      {
        id: 'run-explore',
        kind: 'agent-start',
        depth: 1,
        title: 'explore',
        text: 'who else calls add()?',
        status: 'done',
        agentId: 'run-explore',
      },
      {
        id: 'call-grep',
        kind: 'tool',
        depth: 1,
        title: 'grep',
        text: '"add(" in src',
        status: 'done',
        write: false,
      },
      {
        id: 'call-read_file',
        kind: 'tool',
        depth: 1,
        title: 'read',
        text: 'src/cli.mjs',
        status: 'done',
        write: false,
      },
      {
        id: 'run-explore:end',
        kind: 'agent-end',
        depth: 1,
        title: 'explore',
        text: '1 caller, nothing to change',
        status: 'done',
        agentId: 'run-explore',
      },
    ])
    // The tool call that started the agent shows as the branch only.
    expect(sessionRows.some((row) => row.id === 'call-explore')).toBe(false)

    const lines = layoutLines(sessionRows, 48)
    const text = plain(lines)
    const start = text.indexOf('├─╮')
    expect(text.slice(start, start + 6)).toEqual([
      '├─╮',
      '│ ●  explore   who else calls add()?',
      '│ │  ◇ grep      "add(" in src',
      '│ │  ◇ read      src/cli.mjs',
      '│ ●  explore   1 caller, nothing to change',
      '├─╯',
    ])
    expect(lines[start]?.rowId).toBe('run-explore')
    expect(lines[start + 5]?.rowId).toBe('run-explore:end')
    // The lead lane is indigo, and the lane of the subagent is lavender.
    expect(lineAt(lines, '│ │  ◇ grep').segments.slice(0, 3)).toEqual([
      { text: '│', fg: color.indigoDim },
      { text: ' ' },
      { text: '│', fg: color.lavender, dim: true },
    ])
    expect(lineAt(lines, '│ ●  explore').segments[2]).toEqual({
      text: '●',
      fg: color.lavender,
      bold: true,
    })
  })

  test('nested subagents get depth 2', () => {
    const rows = buildRows(
      [
        assistant('turn-1', [
          toolCall('explore', { prompt: 'check a.ts' }),
          agentPart('run-outer', [
            toolCall('general', { prompt: 'read a.ts' }),
            agentPart(
              'run-inner',
              [
                toolCall('read_file', { path: 'src/a.ts' }),
                textPart('a.ts is fine'),
              ],
              { name: 'general' },
            ),
            textPart('done'),
          ]),
        ]),
      ],
      options,
    )
    expect(rows.map((row) => [row.kind, row.depth])).toEqual([
      ['agent-start', 1],
      ['agent-start', 2],
      ['tool', 2],
      ['agent-end', 2],
      ['agent-end', 1],
    ])
    expect(plain(layoutLines(rows, 48))).toEqual([
      '├─╮',
      '│ ●  explore   check a.ts',
      '│ ├─╮',
      '│ │ ●  general   read a.ts',
      '│ │ │  ◇ read      src/a.ts',
      '│ │ ●  general   a.ts is fine',
      '│ ├─╯',
      '│ ●  explore   done',
      '├─╯',
      '┊',
    ])
  })

  test('an edit row has +1 −1 from counts', () => {
    const edit = sessionRows.find((row) => row.id === 'call-edit-1')
    expect(edit).toEqual({
      id: 'call-edit-1',
      kind: 'tool',
      depth: 0,
      title: 'edit',
      text: 'src/math.mjs',
      status: 'done',
      write: true,
      additions: 1,
      deletions: 1,
    })
    const line = lineAt(layoutLines(sessionRows, 48), '│  ◆ edit      src/math')
    expect(line.segments.slice(-3)).toEqual([
      { text: '+1', fg: color.woad },
      { text: ' ' },
      { text: '−1', fg: color.madder },
    ])
  })

  test('a waiting bash row', () => {
    const bash = sessionRows.find((row) => row.id === 'call-bash')
    expect(bash).toEqual({
      id: 'call-bash',
      kind: 'tool',
      depth: 0,
      title: 'bash',
      text: 'node --test',
      status: 'waiting',
      write: true,
    })
    const line = lineAt(layoutLines(sessionRows, 48), '│  ◆ bash')
    expect(line.segments.slice(-2)).toEqual([
      { text: '⠋', fg: color.weld },
      { text: ' needs you', fg: color.weld },
    ])
  })

  test('a program row keeps the code', () => {
    const program = sessionRows.find((row) => row.kind === 'program')
    expect(program).toEqual({
      id: 'call-execute_typescript',
      kind: 'program',
      depth: 0,
      title: 'program',
      text: 'read 2 files',
      status: 'done',
      write: false,
      code: "// read 2 files\nawait external_read_file({ path: 'src/math.mjs' })",
    })
  })

  test('a program that calls a write tool shows ◆', () => {
    const [program] = buildRows(
      [
        assistant('turn-1', [
          toolCall('execute_typescript', {
            typescriptCode:
              "await external_edit_file({ path: 'a.ts', old: 'a', new: 'b' })",
          }),
        ]),
      ],
      options,
    )
    expect(program?.write).toBe(true)
  })

  test.each([
    ['read_file', { path: 'F:\\projects\\demo\\src\\a.ts' }, 'src/a.ts'],
    ['read_file', { path: 'f:/Projects/demo/src/a.ts' }, 'src/a.ts'],
    ['read_file', { path: 'C:/other/b.ts' }, 'C:/other/b.ts'],
    ['list_files', { pattern: '*.ts', path: 'src' }, '"*.ts" in src'],
    ['bash', { command: 'bun test' }, 'bun test'],
    [
      'patch',
      {
        patch:
          '*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n@@\n-a\n+b\n*** End Patch',
      },
      'src/a.ts, src/b.ts',
    ],
    ['webfetch', { url: 'https://tanstack.com' }, 'https://tanstack.com'],
  ])('%s shows its target', (name, args, target) => {
    const [row] = buildRows([assistant('turn-1', [toolCall(name, args)])], {
      model: 'opus',
      root: 'F:\\projects\\demo\\',
    })
    expect(row?.text).toBe(target)
  })

  test('a docker path is relative to /workspace', () => {
    const [row] = buildRows(
      [assistant('turn-1', [toolCall('read_file', { path: '/workspace/a.ts' })])],
      { model: 'opus', root: '/workspace' },
    )
    expect(row?.text).toBe('a.ts')
  })

  test('a running subagent has no end row, and its lane goes on', () => {
    const rows = buildRows(
      [
        assistant('turn-1', [
          toolCall('explore', { prompt: 'find the callers' }, { status: 'running' }),
          agentPart(
            'run-1',
            [toolCall('grep', { pattern: 'add(' }, { status: 'running' })],
            { status: 'running' },
          ),
        ]),
      ],
      options,
    )
    expect(rows.map((row) => [row.kind, row.status])).toEqual([
      ['agent-start', 'running'],
      ['tool', 'running'],
    ])
    expect(plain(layoutLines(rows, 40))).toEqual([
      '├─╮',
      '│ ●  explore   find the callers',
      `│ │  ◇ grep      "add("${' '.repeat(16)}⠋`,
      '│ ┊',
      '┊',
    ])
  })

  test('a reloaded agent takes its task and result from the call that names it', () => {
    // After a reload, the agent parts are empty, and the calls name their runs.
    const rows = buildRows(
      [
        assistant('turn-1', [
          toolCall(
            'explore',
            { prompt: 'first task' },
            { id: 'call-1', result: { subagentRunId: 'run-1', result: 'one' } },
          ),
          toolCall(
            'explore',
            { prompt: 'second task' },
            { id: 'call-2', result: { subagentRunId: 'run-2', result: 'two' } },
          ),
          agentPart('run-2', []),
          agentPart('run-1', []),
        ]),
      ],
      options,
    )
    expect(rows.map((row) => [row.id, row.text])).toEqual([
      ['run-2', 'second task'],
      ['run-2:end', 'two'],
      ['run-1', 'first task'],
      ['run-1:end', 'one'],
    ])
  })

  test('notices are muted, and errors are madder', () => {
    const rows = buildRows(
      [
        { id: 'notice-0', role: 'notice', kind: 'info', text: 'Resumed a turn.' },
        { id: 'notice-1', role: 'notice', kind: 'error', text: 'Error: rate limit' },
        { id: 'notice-2', role: 'notice', kind: 'rejected', text: 'Not accepted: busy' },
        assistant('turn-1', [
          toolCall('read_file', { path: 'src/a.ts' }, { status: 'failed' }),
          agentPart('run-1', [], { status: 'failed', error: 'model error' }),
        ]),
      ],
      options,
    )
    expect(rows.map((row) => row.kind)).toEqual([
      'notice',
      'error',
      'error',
      'tool',
      'agent-start',
      'agent-end',
    ])
    const lines = layoutLines(rows, 40)
    expect(lineAt(lines, '│  Resumed').segments.at(-1)).toEqual({
      text: 'Resumed a turn.',
      fg: color.muted,
    })
    expect(lineAt(lines, '│  Error').segments.at(-1)).toEqual({
      text: 'Error: rate limit',
      fg: color.madder,
    })
    expect(lineAt(lines, '│  ◇ read').segments.at(-1)).toEqual({
      text: 'failed',
      fg: color.madder,
    })
    expect(lineAt(lines, '│ ●  explore   model').segments.at(-1)).toEqual({
      text: 'model error',
      fg: color.madder,
    })
  })
})

describe('buildAgentRows', () => {
  test('the transcript of an agent has its text and its tools', () => {
    const agent = agentPart('run-1', [
      textPart('I will look for callers.'),
      toolCall('grep', { pattern: 'add(' }),
      textPart('1 caller.'),
    ])
    expect(buildAgentRows(agent, options)).toEqual([
      {
        id: 'run-1:0',
        kind: 'assistant',
        depth: 0,
        title: 'explore',
        text: 'I will look for callers.',
      },
      {
        id: 'call-grep',
        kind: 'tool',
        depth: 0,
        title: 'grep',
        text: '"add("',
        status: 'done',
        write: false,
      },
      {
        id: 'run-1:2',
        kind: 'assistant',
        depth: 0,
        title: 'explore',
        text: '1 caller.',
      },
    ])
  })

  test('a failed agent ends with its error', () => {
    const agent = agentPart('run-1', [toolCall('grep', { pattern: 'add(' })], {
      status: 'failed',
      error: 'model error',
    })
    expect(buildAgentRows(agent, options).at(-1)).toEqual({
      id: 'run-1:error',
      kind: 'error',
      depth: 0,
      title: '',
      text: 'model error',
    })
  })
})

describe('layoutLines', () => {
  test('the session lays out as in the mockup', () => {
    expect(plain(layoutLines(sessionRows, 48))).toEqual([
      '●  you',
      '│  The add test fails. Fix it.',
      '│',
      '│  thinking   The test calls add.',
      '│',
      '●  opus   I will read the code and the test.',
      '│  ◇ program   read 2 files',
      '├─╮',
      '│ ●  explore   who else calls add()?',
      '│ │  ◇ grep      "add(" in src',
      '│ │  ◇ read      src/cli.mjs',
      '│ ●  explore   1 caller, nothing to change',
      '├─╯',
      `│  ◆ edit      src/math.mjs${' '.repeat(16)}+1 −1`,
      `│  ◆ edit      test/math.test.mjs${' '.repeat(13)}+6`,
      `│  ◆ bash      node --test${' '.repeat(11)}⠋ needs you`,
      '┊',
    ])
  })

  test('CJK and emoji wrap by display width', () => {
    const rows = buildRows(
      [
        {
          id: 'user-0',
          role: 'user',
          text: '漢字のテキストと絵文字👋🏽が混ざった長い行です',
        },
      ],
      options,
    )
    const lines = layoutLines(rows, 20)
    expect(plain(lines)).toEqual([
      '●  you',
      '│  漢字のテキストと',
      '│  絵文字👋🏽が混ざっ',
      '│  た長い行です',
      '┊',
    ])
    for (const line of plain(lines)) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(20)
    }
  })

  test('a 2,000-character word wraps', () => {
    const rows = buildRows(
      [{ id: 'user-0', role: 'user', text: 'x'.repeat(2000) }],
      options,
    )
    const text = plain(layoutLines(rows, 40))
    // 37 cells after `│  `: 54 full lines and one line of 2.
    expect(text).toEqual([
      '●  you',
      ...Array.from({ length: 54 }, () => `│  ${'x'.repeat(37)}`),
      '│  xx',
      '┊',
    ])
  })

  test('a long command wraps under its target, and its status gets a line', () => {
    const rows = buildRows(
      [
        assistant('turn-1', [
          toolCall(
            'bash',
            { command: 'npm run build -- --filter @tanstack/ai-harness' },
            { status: 'needs-approval' },
          ),
        ]),
      ],
      options,
    )
    expect(plain(layoutLines(rows, 40))).toEqual([
      '│  ◆ bash      npm run build -- --filter',
      '│              @tanstack/ai-harness',
      `│${' '.repeat(28)}⠋ needs you`,
      '┊',
    ])
  })

  test('no line is wider than a pane that is narrower than the lanes', () => {
    const lines = layoutLines(sessionRows, 4)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of plain(lines)) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(4)
    }
    expect(layoutLines(sessionRows, 0)).toEqual([])
  })
})

describe('markdown and reasoning', () => {
  const answer = [
    '# Fix',
    'The **add** test fails. Run `bun test`.',
    '- one',
    '```ts',
    'add(1, 2)',
    '```',
  ].join('\n')

  test('an answer shows as markdown, and the marks do not show', () => {
    const rows = buildRows([assistant('a1', [textPart(answer)])], options)
    const lines = layoutLines(rows, 60)
    expect(plain(lines).slice(0, 5)).toEqual([
      '●  opus   Fix',
      '│         The add test fails. Run bun test.',
      '│         • one',
      '│           add(1, 2)',
      '┊',
    ])
    const segments = lines.flatMap((line) => line.segments)
    expect(segments.find((segment) => segment.text === 'Fix')?.bold).toBe(true)
    expect(segments.find((segment) => segment.text === 'add')?.bold).toBe(true)
    expect(segments.find((segment) => segment.text === 'bun test')?.fg).toBe(color.keyword)
  })

  test('the reasoning of a model is a muted italic row', () => {
    const parts: Array<ViewPart> = [{ type: 'reasoning', text: 'Check the test first.' }, textPart('Done.')]
    const rows = buildRows([assistant('a1', parts)], options)
    expect(rows.map((row) => row.kind)).toEqual(['reasoning', 'assistant'])
    const line = lineAt(layoutLines(rows, 60), '│  thinking')
    const text = line.segments.find((segment) => segment.text.includes('Check the test first.'))
    expect(text).toMatchObject({ fg: color.muted, italic: true })
  })
})
