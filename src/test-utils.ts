// Test helpers for the modules that draw no screen. Only the tests import this file.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A new temp folder whose name starts with `heddle-`. `using` deletes it after the test. */
export function tempFolder() {
  const path = mkdtempSync(join(tmpdir(), 'heddle-'))
  return {
    path,
    [Symbol.dispose]: () => rmSync(path, { recursive: true, force: true }),
  }
}
