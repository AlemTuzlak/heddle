// The store conformance suite of @tanstack/ai-persistence, on the SQLite
// stores. `bun run test:store` runs it: vitest on Bun, so `bun:sqlite` loads.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPersistenceConformance } from '@tanstack/ai-persistence/testkit'
import { openSqliteStores } from './sqlite'

// The file of each persistence that the factory made, so the twin can open
// the same file.
const paths = new WeakMap<object, string>()

runPersistenceConformance(
  'sqlite',
  () => {
    // Each call gets a new temp file.
    const folder = mkdtempSync(join(tmpdir(), 'heddle-conformance-'))
    const path = join(folder, 'heddle.db')
    const { persistence } = openSqliteStores(path)
    paths.set(persistence, path)
    return persistence
  },
  {
    // heddle keeps the log, the session index, and the metadata. The harness
    // keeps the rest of each session in the log.
    skip: [
      'messages',
      'activities',
      'runs',
      'interrupts',
      'generationRuns',
      'artifacts',
      'blobs',
    ],
    // A second store on the same file, as a second process sees it.
    twin: (persistence) => {
      const path = paths.get(persistence)
      if (path === undefined) {
        throw new Error('The twin needs a persistence from the factory.')
      }
      return openSqliteStores(path).persistence
    },
  },
)
