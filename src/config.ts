import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord, messageOf } from './utils'
import type { McpServerConfig } from '@tanstack/ai-mcp/harness'

/** The settings of heddle. {@link loadConfig} reads them from the config files. */
export interface HeddleConfig {
  /** The name of the model, such as `'opus'`. The harness checks the name. */
  model?: string
  /**
   * `false` (the default): the tools work in the project folder.
   * `{ image }`: the tools work in a Docker container of that image. In a
   * file, `true` is `{ image: 'node:24' }`.
   */
  sandbox: false | { image: string }
  /**
   * `false`: no code mode. `{ directCalls }`: the model can write programs
   * that call the tools. With `'keep'`, the model can also call these tools
   * directly. With `'remove'`, only programs can call them. The default, and
   * `true` in a file, is `{ directCalls: 'keep' }`.
   */
  codeMode: false | { directCalls: 'keep' | 'remove' }
  /** The MCP servers, by name. The default is no servers. */
  mcp: Record<string, McpServerConfig>
}

/**
 * Reads the config of heddle from two files, and checks each field:
 *
 * 1. `<home>/.heddle/config.json`
 * 2. `<project>/.heddle/config.json`
 *
 * - A missing file is fine. With no files, you get the defaults.
 * - A field of the project file wins over the same field of the home file.
 * - `mcp` merges by server name. A project server replaces the home server
 *   with the same name.
 *
 * It throws an `Error` for bad JSON, for a field with a wrong value, and for
 * a field that heddle does not know. The message starts with the path of the
 * file, and then names the field. For example:
 * `/home/ana/.heddle/config.json: codeMode must be true, false, or an object`.
 *
 * @param options.home - The home folder of the user.
 * @param options.project - The project folder.
 *
 * @example
 * ```ts
 * const config = loadConfig({ home: os.homedir(), project: process.cwd() })
 * ```
 */
export function loadConfig(options: { home: string; project: string }) {
  const home = readConfigFile(join(options.home, '.heddle', 'config.json'))
  const project = readConfigFile(
    join(options.project, '.heddle', 'config.json'),
  )
  const config: HeddleConfig = {
    sandbox: false,
    codeMode: defaultCodeMode(),
    ...home,
    ...project,
    mcp: { ...home.mcp, ...project.mcp },
  }
  return config
}

/** The Docker image of `"sandbox": true`, and of a docker session when the config names none. */
export const DEFAULT_IMAGE = 'node:24'

/** The code mode of `"codeMode": true`, and of a config without `codeMode`. */
function defaultCodeMode() {
  return { directCalls: 'keep' as const }
}

/** The fields of a config file. The type makes sure that no field is missing. */
const CONFIG_FIELDS: Record<keyof HeddleConfig, true> = {
  model: true,
  sandbox: true,
  codeMode: true,
  mcp: true,
}

type HttpServer = Extract<McpServerConfig, { type: 'http' }>
type StdioServer = Extract<McpServerConfig, { type: 'stdio' }>

/**
 * The fields of `McpServerConfig` that JSON cannot hold: functions, and
 * objects with methods. A config file cannot set them.
 */
type CodeOnlyField = 'fetch' | 'authProvider' | 'toolName'

/** The fields that both kinds of MCP server have. */
type SharedField = 'timeoutMs' | 'codeMode' | 'needsApproval'

/**
 * The fields of each kind of MCP server in a config file. The types make
 * sure that each field that JSON can hold is here. In a file,
 * `needsApproval` can only be `true` or `false`.
 */
const HTTP_FIELDS: Record<Exclude<keyof HttpServer, CodeOnlyField>, true> = {
  type: true,
  url: true,
  headers: true,
  oauth: true,
  timeoutMs: true,
  codeMode: true,
  needsApproval: true,
}
const STDIO_FIELDS: Record<Exclude<keyof StdioServer, CodeOnlyField>, true> = {
  type: true,
  command: true,
  args: true,
  env: true,
  cwd: true,
  timeoutMs: true,
  codeMode: true,
  needsApproval: true,
}

/** The checked fields of one config file. A missing file sets no field. */
function readConfigFile(file: string) {
  const text = readText(file)
  const fields: Partial<HeddleConfig> =
    text === undefined ? {} : configOf(parseJson(text, file), file)
  return fields
}

/** The text of `file`, or `undefined` when the file does not exist. */
function readText(file: string) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    const isMissing =
      error instanceof Error && 'code' in error && error.code === 'ENOENT'
    if (isMissing) return undefined
    throw badField(file, 'the file', `cannot be read (${messageOf(error)})`)
  }
}

/** The JSON value of `text`, the text of `file`. */
function parseJson(text: string, file: string) {
  try {
    // Some Windows editors write a byte order mark (BOM) at the start of
    // the file. JSON.parse does not accept it.
    const json: unknown = JSON.parse(text.replace(/^﻿/, ''))
    return json
  } catch (error) {
    throw badField(file, 'the file', `is not valid JSON (${messageOf(error)})`)
  }
}

/**
 * The fields of one config file, after the checks. A field that the file
 * does not set stays out, so that it does not hide the field of the home file.
 */
function configOf(json: unknown, file: string) {
  if (!isRecord(json)) {
    throw badField(file, 'the file', 'must contain a JSON object')
  }
  const fields = knownFields(json, CONFIG_FIELDS, file, '')
  const config: Partial<HeddleConfig> = {}
  if (fields.model !== undefined) {
    config.model = stringOf(fields.model, file, 'model')
  }
  if (fields.sandbox !== undefined) {
    config.sandbox = sandboxOf(fields.sandbox, file)
  }
  if (fields.codeMode !== undefined) {
    config.codeMode = codeModeOf(fields.codeMode, file)
  }
  if (fields.mcp !== undefined) config.mcp = serversOf(fields.mcp, file)
  return config
}

/** The `sandbox` field. `true` is the default image. */
function sandboxOf(value: unknown, file: string) {
  if (value === false) return false
  if (value === true) return { image: DEFAULT_IMAGE }
  if (!isRecord(value)) {
    throw badField(file, 'sandbox', 'must be true, false, or an object')
  }
  const fields = knownFields(value, { image: true }, file, 'sandbox')
  return { image: stringOf(fields.image, file, 'sandbox.image') }
}

/** The `codeMode` field. `true` is the default code mode. */
function codeModeOf(value: unknown, file: string) {
  if (value === false) return false
  if (value === true) return defaultCodeMode()
  if (!isRecord(value)) {
    throw badField(file, 'codeMode', 'must be true, false, or an object')
  }
  const fields = knownFields(value, { directCalls: true }, file, 'codeMode')
  const directCalls = oneOf(
    fields.directCalls,
    ['keep', 'remove'],
    file,
    'codeMode.directCalls',
  )
  return { directCalls }
}

/** The `mcp` field: the servers, by name. */
function serversOf(value: unknown, file: string) {
  if (!isRecord(value)) throw badField(file, 'mcp', 'must be an object')
  // `Object.fromEntries`, so that a server named `__proto__` stays a server.
  const servers = Object.entries(value).map(
    ([name, server]) => [name, serverOf(server, file, `mcp.${name}`)] as const,
  )
  return Object.fromEntries(servers)
}

/** One MCP server. Its `type` tells which fields it can have. */
function serverOf(value: unknown, file: string, path: string) {
  if (!isRecord(value)) throw badField(file, path, 'must be an object')
  const type = oneOf(value.type, ['http', 'stdio'], file, `${path}.type`)
  if (type === 'http') {
    const fields = knownFields(value, HTTP_FIELDS, file, path)
    const server: HttpServer = {
      type,
      url: stringOf(fields.url, file, `${path}.url`),
      ...sharedFieldsOf(fields, file, path),
    }
    if (fields.headers !== undefined) {
      server.headers = stringMapOf(fields.headers, file, `${path}.headers`)
    }
    if (fields.oauth !== undefined) {
      server.oauth = booleanOf(fields.oauth, file, `${path}.oauth`)
    }
    return server
  }
  const fields = knownFields(value, STDIO_FIELDS, file, path)
  const server: StdioServer = {
    type,
    command: stringOf(fields.command, file, `${path}.command`),
    ...sharedFieldsOf(fields, file, path),
  }
  if (fields.args !== undefined) {
    server.args = stringListOf(fields.args, file, `${path}.args`)
  }
  if (fields.env !== undefined) {
    server.env = stringMapOf(fields.env, file, `${path}.env`)
  }
  if (fields.cwd !== undefined) {
    server.cwd = stringOf(fields.cwd, file, `${path}.cwd`)
  }
  return server
}

/**
 * The fields that both kinds of MCP server have. A field that is not set
 * stays out.
 */
function sharedFieldsOf(
  fields: Partial<Record<SharedField, unknown>>,
  file: string,
  path: string,
) {
  const shared: Pick<McpServerConfig, SharedField> = {}
  if (fields.timeoutMs !== undefined) {
    shared.timeoutMs = positiveNumberOf(
      fields.timeoutMs,
      file,
      `${path}.timeoutMs`,
    )
  }
  if (fields.codeMode !== undefined) {
    shared.codeMode = booleanOf(fields.codeMode, file, `${path}.codeMode`)
  }
  if (fields.needsApproval !== undefined) {
    shared.needsApproval = booleanOf(
      fields.needsApproval,
      file,
      `${path}.needsApproval`,
    )
  }
  return shared
}

/**
 * The fields of the JSON object `value`, with the names of `known`. It
 * throws for a field that is not in `known`, so that a typo does not go
 * unseen. `path` is the field path of `value`, or `''` for the whole file.
 */
function knownFields<K extends string>(
  // `NoInfer`: the names come from `known` only. Then the call checks that
  // `value` can have those fields.
  value: Partial<Record<NoInfer<K>, unknown>>,
  known: Record<K, true>,
  file: string,
  path: string,
) {
  const keys = Object.keys(value)
  const unknownKey = keys.find((key) => !Object.hasOwn(known, key))
  if (unknownKey !== undefined) {
    const field = path === '' ? unknownKey : `${path}.${unknownKey}`
    const list = Object.keys(known).join(', ')
    throw badField(file, field, `is not a known field (known fields: ${list})`)
  }
  return value
}

function stringOf(value: unknown, file: string, field: string) {
  if (typeof value !== 'string') throw badField(file, field, 'must be a string')
  return value
}

function booleanOf(value: unknown, file: string, field: string) {
  if (typeof value !== 'boolean') {
    throw badField(file, field, 'must be true or false')
  }
  return value
}

function positiveNumberOf(value: unknown, file: string, field: string) {
  if (typeof value !== 'number' || value <= 0) {
    throw badField(file, field, 'must be a number above 0')
  }
  return value
}

/** A list of strings, such as `args`. */
function stringListOf(value: unknown, file: string, field: string) {
  if (!Array.isArray(value)) {
    throw badField(file, field, 'must be a list of strings')
  }
  return value.map((item, index) => stringOf(item, file, `${field}[${index}]`))
}

/** An object with string values, such as `env` or `headers`. */
function stringMapOf(value: unknown, file: string, field: string) {
  if (!isRecord(value)) {
    throw badField(file, field, 'must be an object with string values')
  }
  const entries = Object.entries(value).map(
    ([key, item]) => [key, stringOf(item, file, `${field}.${key}`)] as const,
  )
  return Object.fromEntries(entries)
}

/** `value` when it is one of `choices`. */
function oneOf<T extends string>(
  value: unknown,
  choices: ReadonlyArray<T>,
  file: string,
  field: string,
) {
  const choice = choices.find((item) => item === value)
  if (choice === undefined) {
    const names = choices.map((item) => JSON.stringify(item)).join(' or ')
    throw badField(file, field, `must be ${names}`)
  }
  return choice
}

/** The error for one field of a config file: `<file>: <field> <problem>`. */
function badField(file: string, field: string, problem: string) {
  return new Error(`${file}: ${field} ${problem}`)
}
