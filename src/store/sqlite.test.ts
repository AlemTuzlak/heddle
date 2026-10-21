import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NO_OWNER_EPOCH } from '@tanstack/ai-persistence'
import { openSqliteStores } from './sqlite'
import type { LogStore } from '@tanstack/ai-persistence'
import type { SqliteStores } from './sqlite'

// The stores and the temp folders of the test that runs. afterEach closes
// the stores first, because Windows cannot remove an open file.
const opened: Array<SqliteStores> = []
const folders: Array<string> = []

afterEach(() => {
  const toClose = opened.splice(0)
  const toRemove = folders.splice(0)
  for (const stores of toClose) stores.close()
  for (const folder of toRemove) {
    rmSync(folder, { recursive: true, force: true })
  }
})

/** A path for a database file in a new temp folder. */
function newDatabasePath() {
  const folder = mkdtempSync(join(tmpdir(), 'heddle-store-'))
  folders.push(folder)
  return join(folder, 'heddle.db')
}

/** Open the stores at `path`. afterEach closes them. */
function open(path: string) {
  const stores = openSqliteStores(path)
  opened.push(stores)
  return stores
}

/** Gives 'woke' when a listener of `log` for `logId` is called. */
function nextWake(log: LogStore, logId: string) {
  return new Promise<'woke'>((resolve) => {
    const stop = log.subscribe({
      logId,
      listener: () => {
        stop()
        resolve('woke')
      },
    })
  })
}

test('credentials round trip', async () => {
  const { credentials } = open(':memory:')
  const alice = { userId: 'alice' }
  const bob = { userId: 'bob' }
  await credentials.set({
    scope: alice,
    id: 'anthropic',
    credential: { type: 'api_key', value: 'sk-alice' },
  })
  await credentials.set({
    scope: bob,
    id: 'anthropic',
    credential: { type: 'api_key', value: 'sk-bob' },
  })
  await credentials.set({
    scope: bob,
    id: 'linear',
    credential: { type: 'oauth', accessToken: 'token-bob', expiresAt: 1_000 },
  })

  expect(await credentials.get({ scope: alice, id: 'anthropic' })).toEqual({
    type: 'api_key',
    value: 'sk-alice',
  })
  expect(await credentials.get({ scope: bob, id: 'anthropic' })).toEqual({
    type: 'api_key',
    value: 'sk-bob',
  })
  // The list has the ids and the types, and no secret.
  expect(await credentials.list(alice)).toEqual([
    { id: 'anthropic', type: 'api_key' },
  ])
  expect(await credentials.list(bob)).toEqual([
    { id: 'anthropic', type: 'api_key' },
    { id: 'linear', type: 'oauth', expiresAt: 1_000 },
  ])

  await credentials.delete({ scope: alice, id: 'anthropic' })

  expect(await credentials.get({ scope: alice, id: 'anthropic' })).toBeNull()
  expect(await credentials.list(alice)).toEqual([])
  // The key of bob stays.
  expect(await credentials.get({ scope: bob, id: 'anthropic' })).toEqual({
    type: 'api_key',
    value: 'sk-bob',
  })
})

test('data survives a reopen', async () => {
  const path = newDatabasePath()
  const first = open(path)
  await first.persistence.stores.log.append({
    logId: 'session-1',
    seq: 1,
    epoch: NO_OWNER_EPOCH,
    records: [{ type: 'a' }, { type: 'b' }, { type: 'c' }],
  })
  first.close()

  const second = open(path)

  expect(await second.persistence.stores.log.read({ logId: 'session-1' })).toEqual([
    { seq: 1, record: { type: 'a' } },
    { seq: 2, record: { type: 'b' } },
    { seq: 3, record: { type: 'c' } },
  ])
})

test('two stores on one file see each other', async () => {
  const path = newDatabasePath()
  const a = open(path).persistence.stores.log
  const b = open(path).persistence.stores.log
  // Only the poll of B can see a write of A: they are two connections.
  const woke = nextWake(b, 'session-1')

  await a.append({
    logId: 'session-1',
    seq: 1,
    epoch: NO_OWNER_EPOCH,
    records: [{ type: 'from-a' }],
  })

  const late = Bun.sleep(1_000).then(() => 'not in 1 s')
  expect(await Promise.race([woke, late])).toBe('woke')
  expect(await b.read({ logId: 'session-1' })).toEqual([
    { seq: 1, record: { type: 'from-a' } },
  ])
})
