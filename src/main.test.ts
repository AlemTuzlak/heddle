import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import packageJson from '../package.json'
import { parseFlags, type Flags } from './main'
import { tempFolder } from './test-utils'

/** The flags of `heddle` with no arguments. */
const NO_FLAGS: Flags = { continue: false, resume: false, sandbox: false, help: false, version: false }

/** The heddle repo. `--help` and `--version` run in it. */
const REPO = join(import.meta.dir, '..')

/** The entry file. The path is absolute, so heddle can run in any folder. */
const MAIN = join(import.meta.dir, 'main.tsx')

/**
 * A spawned heddle that runs longer than this is stopped. The first run in a
 * new home is slow, because Bun fills its cache there.
 */
const SPAWN_TIMEOUT_MS = 20_000

/** The time limit of a test that spawns heddle. It is longer than {@link SPAWN_TIMEOUT_MS}. */
const SPAWN_TEST_TIMEOUT_MS = 30_000

/**
 * Runs `bun src/main.tsx <args>` in the folder `cwd`, and gives its exit
 * code and its output. `env` adds to the environment of the test.
 */
async function runHeddle(
  args: ReadonlyArray<string>,
  options: { cwd: string; env?: Record<string, string> },
) {
  const child = Bun.spawn([process.execPath, MAIN, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: SPAWN_TIMEOUT_MS,
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

test('no flags', () => {
  expect(parseFlags([])).toEqual(NO_FLAGS)
})

test.each([
  ['-c', { continue: true }],
  ['-r', { resume: true }],
  ['--sandbox', { sandbox: true }],
  ['-h', { help: true }],
  ['-v', { version: true }],
] as const)('%s', (flag, set) => {
  expect(parseFlags([flag])).toEqual({ ...NO_FLAGS, ...set })
})

test('an unknown flag throws a short message', () => {
  expect(() => parseFlags(['--nope'])).toThrow(
    new Error("Unknown option '--nope'. Type heddle --help."),
  )
})

test('an argument that is not a flag throws a short message', () => {
  // Here the error of parseArgs has a second sentence. heddle cuts it.
  expect(() => parseFlags(['nope'])).toThrow(
    new Error("Unexpected argument 'nope'. Type heddle --help."),
  )
})

test(
  '--help prints the usage',
  async () => {
    const result = await runHeddle(['--help'], { cwd: REPO })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toStartWith('Usage: heddle')
    // The usage names each flag, the config files, and the ways to give a key.
    const names = [
      '-c, --continue',
      '-r, --resume',
      '--sandbox',
      '-h, --help',
      '-v, --version',
      '~/.heddle/config.json',
      '<project>/.heddle/config.json',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'XAI_API_KEY',
      '/connect',
    ]
    for (const name of names) expect(result.stdout).toContain(name)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  '--version prints the version',
  async () => {
    const result = await runHeddle(['--version'], { cwd: REPO })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/^heddle \d+\.\d+\.\d+/)
    expect(result.stdout).toBe(`heddle ${packageJson.version}\n`)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  'a bad model in the project config exits 1 with one line',
  async () => {
    using folder = tempFolder()
    const project = join(folder.path, 'project')
    const home = join(folder.path, 'home')
    mkdirSync(join(project, '.heddle'), { recursive: true })
    writeFileSync(join(project, '.heddle', 'config.json'), JSON.stringify({ model: 'nope' }))
    // Both names, so that the home is the temp folder on each system.
    const result = await runHeddle([], { cwd: project, env: { HOME: home, USERPROFILE: home } })
    expect(result.exitCode).toBe(1)
    // The error comes before the screen starts, so nothing goes to stdout.
    expect(result.stdout).toBe('')
    const lines = result.stderr.trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith('heddle could not start: Unknown model "nope".')
    // The log file has the error with its stack.
    const log = readFileSync(join(home, '.heddle', 'logs', 'heddle.log'), 'utf8')
    expect(log).toContain('error heddle could not start.\nError: Unknown model "nope".')
  },
  SPAWN_TEST_TIMEOUT_MS,
)
