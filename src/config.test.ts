import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config'
import type { McpServerConfig } from '@tanstack/ai-mcp/harness'

/** A new home folder and project folder. `using` deletes them after the test. */
function tempFolders() {
  const root = mkdtempSync(join(tmpdir(), 'heddle-config-'))
  return {
    home: join(root, 'home'),
    project: join(root, 'project'),
    [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }),
  }
}

/**
 * Writes `<folder>/.heddle/config.json`, and gives its path. An object is
 * written as JSON. A string is written as it is.
 */
function writeConfig(folder: string, content: string | object) {
  mkdirSync(join(folder, '.heddle'), { recursive: true })
  const file = join(folder, '.heddle', 'config.json')
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  writeFileSync(file, text)
  return file
}

/** Writes `content` as the project file, and expects `<file>: <problem>`. */
function expectProjectError(content: string | object, problem: string) {
  using folders = tempFolders()
  const file = writeConfig(folders.project, content)
  expect(() => loadConfig(folders)).toThrow(new Error(`${file}: ${problem}`))
}

test('no files gives the defaults', () => {
  using folders = tempFolders()
  expect(loadConfig(folders)).toEqual({
    sandbox: false,
    codeMode: { directCalls: 'keep' },
    mcp: {},
  })
})

test('project wins over home', () => {
  using folders = tempFolders()
  writeConfig(folders.home, {
    model: 'opus',
    sandbox: { image: 'oven/bun:1' },
    codeMode: false,
  })
  writeConfig(folders.project, {
    model: 'sonnet',
    codeMode: { directCalls: 'remove' },
  })
  expect(loadConfig(folders)).toEqual({
    model: 'sonnet',
    sandbox: { image: 'oven/bun:1' },
    codeMode: { directCalls: 'remove' },
    mcp: {},
  })
})

test('mcp merges by name', () => {
  using folders = tempFolders()
  const linear: McpServerConfig = {
    type: 'http',
    url: 'https://mcp.linear.app/mcp',
    oauth: true,
  }
  const notion: McpServerConfig = {
    type: 'http',
    url: 'https://mcp.notion.com/mcp',
    oauth: true,
  }
  writeConfig(folders.home, {
    mcp: { linear, files: { type: 'stdio', command: 'npx', args: ['-y', 'fs'] } },
  })
  writeConfig(folders.project, {
    mcp: { files: { type: 'stdio', command: 'bunx' }, notion },
  })
  // The project server replaces the whole home server, so `args` is gone.
  expect(loadConfig(folders).mcp).toEqual({
    linear,
    files: { type: 'stdio', command: 'bunx' },
    notion,
  })
})

test('sandbox true gives node:24', () => {
  using folders = tempFolders()
  writeConfig(folders.project, { sandbox: true })
  expect(loadConfig(folders).sandbox).toEqual({ image: 'node:24' })
})

test('codeMode true gives the default', () => {
  using folders = tempFolders()
  writeConfig(folders.home, { codeMode: false })
  writeConfig(folders.project, { codeMode: true })
  expect(loadConfig(folders).codeMode).toEqual({ directCalls: 'keep' })
})

test('bad JSON names the file', () => {
  using folders = tempFolders()
  writeConfig(folders.home, { model: 'opus' })
  const file = writeConfig(folders.project, '{ "model": "opus", }')
  expect(() => loadConfig(folders)).toThrow(
    `${file}: the file is not valid JSON (`,
  )
})

test('codeMode "yes" names the field', () => {
  expectProjectError(
    { codeMode: 'yes' },
    'codeMode must be true, false, or an object',
  )
})

test('an unknown key is an error', () => {
  expectProjectError(
    { modle: 'opus' },
    'modle is not a known field (known fields: model, sandbox, codeMode, mcp)',
  )
})

test('an http and a stdio mcp server are accepted', () => {
  using folders = tempFolders()
  // Together, these servers set every field that a file can set.
  const mcp: Record<string, McpServerConfig> = {
    linear: {
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      oauth: true,
      needsApproval: true,
    },
    docs: {
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer abc' },
      timeoutMs: 10_000,
      codeMode: true,
    },
    files: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      env: { DEBUG: '1' },
      cwd: 'tools',
      timeoutMs: 5_000,
      codeMode: false,
      needsApproval: false,
    },
  }
  writeConfig(folders.project, { mcp })
  expect(loadConfig(folders).mcp).toEqual(mcp)
})

const DOCS_URL = 'https://mcp.example.com/mcp'

/** A config with the http server `docs`, plus `fields`. */
function docsServer(fields: object) {
  return { mcp: { docs: { type: 'http', url: DOCS_URL, ...fields } } }
}

/** A config with the stdio server `files`, plus `fields`. */
function filesServer(fields: object) {
  return { mcp: { files: { type: 'stdio', command: 'npx', ...fields } } }
}

// Each check, and a project file that fails it.
const wrongFields = [
  ['the file must contain a JSON object', []],
  ['model must be a string', { model: 5 }],
  ['sandbox must be true, false, or an object', { sandbox: 'docker' }],
  ['sandbox.image must be a string', { sandbox: {} }],
  [
    'codeMode.directCalls must be "keep" or "remove"',
    { codeMode: { directCalls: 'all' } },
  ],
  ['mcp must be an object', { mcp: ['linear'] }],
  ['mcp.docs must be an object', { mcp: { docs: DOCS_URL } }],
  [
    'mcp.docs.type must be "http" or "stdio"',
    { mcp: { docs: { type: 'sse', url: DOCS_URL } } },
  ],
  [
    'mcp.docs.command is not a known field (known fields: type, url, headers, oauth, timeoutMs, codeMode, needsApproval)',
    docsServer({ command: 'npx' }),
  ],
  ['mcp.docs.oauth must be true or false', docsServer({ oauth: 'yes' })],
  ['mcp.docs.timeoutMs must be a number above 0', docsServer({ timeoutMs: 0 })],
  ['mcp.files.command must be a string', { mcp: { files: { type: 'stdio' } } }],
  [
    'mcp.files.args must be a list of strings',
    filesServer({ args: '-y fs' }),
  ],
  ['mcp.files.env.PORT must be a string', filesServer({ env: { PORT: 8080 } })],
] as const

test.each(wrongFields)('%s', (problem, content) => {
  expectProjectError(content, problem)
})

test('a UTF-8 BOM at the start is fine', () => {
  using folders = tempFolders()
  writeConfig(folders.project, '﻿{ "model": "opus" }')
  expect(loadConfig(folders).model).toBe('opus')
})

test('a file that cannot be read names the file', () => {
  using folders = tempFolders()
  // A folder where the file must be.
  const file = join(folders.project, '.heddle', 'config.json')
  mkdirSync(file, { recursive: true })
  expect(() => loadConfig(folders)).toThrow(`${file}: the file cannot be read (`)
})
