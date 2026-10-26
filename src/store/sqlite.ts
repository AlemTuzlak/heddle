import { Database } from 'bun:sqlite'
import {
  LogConflictError,
  LogTruncatedError,
  NO_OWNER_EPOCH,
  OwnershipLostError,
  defineAIPersistence,
  defineLogStore,
  defineMetadataStore,
  defineSessionIndexStore,
} from '@tanstack/ai-persistence'
import { defineCredentialStore } from '@tanstack/ai/byok'
import type {
  AIPersistence,
  LogStore,
  MetadataStore,
  OrphanedLog,
  SessionIndexEntry,
  SessionIndexKey,
  SessionIndexStore,
} from '@tanstack/ai-persistence'
import type {
  Credential,
  CredentialScope,
  CredentialStore,
} from '@tanstack/ai/byok'

/** The heddle stores in one SQLite file. Make them with {@link openSqliteStores}. */
export interface SqliteStores {
  /** The session log, the session index, and the metadata. Give it to `createHarnessHost`. */
  persistence: AIPersistence<{
    log: LogStore
    sessions: SessionIndexStore
    metadata: MetadataStore
  }>
  /** The API keys and the OAuth tokens, as plain text. Give it to `createHarnessHost`. */
  credentials: CredentialStore
  /** Stop the log poll and close the file. Call it after `host.close()`. */
  close(): void
}

// How often a log store looks for writes from other processes.
const POLL_MS = 100

const SCHEMA = `
-- One row for each log. The row stays after deleteLog, so the epoch never goes down.
CREATE TABLE IF NOT EXISTS logs (
  log_id TEXT PRIMARY KEY,
  -- The last position. A truncate does not change it.
  head INTEGER NOT NULL DEFAULT 0,
  -- The first position that the log keeps. A truncate moves it up.
  first_seq INTEGER NOT NULL DEFAULT 1,
  -- 1 after deleteLog, until the next acquire.
  deleted INTEGER NOT NULL DEFAULT 0,
  -- The ownership. owner_id is NULL when no host ever acquired the log.
  epoch INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT,
  harness TEXT,
  expires_at INTEGER,
  released INTEGER NOT NULL DEFAULT 0,
  wake_at INTEGER,
  affinity TEXT,
  -- The harness of the first offer, for a log that no host acquired.
  lane_harness TEXT,
  snapshot_seq INTEGER,
  snapshot TEXT,
  -- Goes up on each append, offer, and delete. A poll compares it to find the logs that changed.
  change_count INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS log_records (
  log_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (log_id, seq)
) WITHOUT ROWID;
-- A consumed offer stays, so a retry of its id is a duplicate. position keeps the offer order.
CREATE TABLE IF NOT EXISTS log_offers (
  position INTEGER PRIMARY KEY,
  log_id TEXT NOT NULL,
  input_id TEXT NOT NULL,
  record TEXT NOT NULL,
  offered_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (log_id, input_id)
);
CREATE TABLE IF NOT EXISTS log_hosts (
  host_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
-- The default tenant is ''.
CREATE TABLE IF NOT EXISTS sessions (
  tenant_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  entry TEXT NOT NULL,
  revision TEXT NOT NULL,
  PRIMARY KEY (tenant_id, thread_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sessions_by_update
  ON sessions (tenant_id, updated_at DESC, thread_id);
CREATE TABLE IF NOT EXISTS metadata (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  revision TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
) WITHOUT ROWID;
-- A missing tenant or user is ''.
CREATE TABLE IF NOT EXISTS credentials (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  credential TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, id)
) WITHOUT ROWID;
`

/**
 * Open the heddle stores in the SQLite file at `path`, and make the tables
 * that are missing. The file uses WAL mode, so other processes can read it
 * while one process writes. A write waits up to 5 s for another process.
 *
 * @param path - The database file, for example `~/.heddle/heddle.db`. Its
 *   folder must exist. `':memory:'` gives a database that is lost on close.
 *
 * @example
 * ```ts
 * const stores = openSqliteStores(join(home, '.heddle', 'heddle.db'))
 * const host = createHarnessHost({
 *   persistence: stores.persistence,
 *   credentials: stores.credentials,
 * })
 * // At exit:
 * await host.close()
 * stores.close()
 * ```
 */
export function openSqliteStores(path: string) {
  const db = new Database(path, { strict: true })
  // Set the wait first, so that the change to WAL mode can wait too.
  db.run('PRAGMA busy_timeout = 5000')
  db.run('PRAGMA journal_mode = WAL')
  db.run(SCHEMA)
  const log = sqliteLogStore(db)
  const stores: SqliteStores = {
    persistence: defineAIPersistence({
      stores: {
        log: log.store,
        sessions: sqliteSessionStore(db),
        metadata: sqliteMetadataStore(db),
      },
    }),
    credentials: sqliteCredentialStore(db),
    close: () => {
      log.stop()
      db.close()
    },
  }
  return stores
}

// The columns of a `logs` row that the checks read.
type LogRow = {
  head: number
  firstSeq: number
  deleted: number
  epoch: number
  ownerId: string | null
  expiresAt: number | null
  released: number
  affinity: string | null
  snapshotSeq: number | null
}
type LogKey = { logId: string }
type OfferKey = { logId: string; inputId: string }

/**
 * The fence of `append`. A log that a host acquired needs the current epoch
 * and an owner that did not release it. A log that no host acquired needs
 * NO_OWNER_EPOCH. A deleted log refuses every epoch until an acquire.
 */
function canWrite(log: LogRow | null, epoch: number) {
  if (log?.deleted === 1) return false
  if (log === null || log.ownerId === null) return epoch === NO_OWNER_EPOCH
  return log.epoch === epoch && log.released === 0
}

// The contract refuses a ttl of 0 or less, also NaN.
function assertTtl(ttlMs: number) {
  if (!(ttlMs > 0)) {
    throw new RangeError(`ttlMs must be more than 0, got ${ttlMs}.`)
  }
}

// The contract refuses a wake time below 0, also NaN.
function assertWake(wakeInMs: number) {
  if (!(wakeInMs >= 0)) {
    throw new RangeError(`wakeInMs must be 0 or more, got ${wakeInMs}.`)
  }
}

// The logs that have work and no live owner. See `LogStore.listLogsWithoutOwner`.
const ORPHANS_SQL = `
WITH log_state AS (
  SELECT
    log_id, owner_id, released, expires_at, wake_at, affinity,
    -- The owner names the harness. A log that no host acquired has the harness of its first offer.
    CASE WHEN owner_id IS NULL THEN lane_harness ELSE harness END AS harness,
    (SELECT log_offers.offered_at FROM log_offers
      WHERE log_offers.log_id = logs.log_id AND log_offers.consumed = 0
      ORDER BY log_offers.position LIMIT 1) AS offered_at
  FROM logs
),
due AS (
  SELECT
    log_id, harness, affinity,
    -- The first reason that applies. A held log has work only when its owner expired.
    CASE
      WHEN owner_id IS NOT NULL AND released = 0 THEN
        CASE WHEN expires_at <= $now THEN 'expired' END
      WHEN offered_at IS NOT NULL THEN 'offered'
      WHEN wake_at <= $now THEN 'wake'
    END AS reason,
    CASE
      WHEN owner_id IS NOT NULL AND released = 0 THEN expires_at
      WHEN offered_at IS NOT NULL THEN offered_at
      ELSE wake_at
    END AS due_at
  FROM log_state
)
SELECT log_id AS logId, harness, reason FROM due
WHERE reason IS NOT NULL
  AND ($harnesses IS NULL OR harness IN (SELECT value FROM json_each($harnesses)))
  -- A pin counts only while its host is alive.
  AND (affinity IS NULL OR affinity = $affinity OR NOT EXISTS (
    SELECT 1 FROM log_hosts
    WHERE log_hosts.host_id = due.affinity AND log_hosts.expires_at > $now))
ORDER BY due_at, log_id
LIMIT $limit
`

/**
 * The log store on `db`. Its writes wake its own listeners at once. A poll
 * finds the writes of other connections (other processes, or a second store
 * on the same file) through `PRAGMA data_version`. The poll runs only while
 * a listener waits.
 */
function sqliteLogStore(db: Database) {
  const selectLog = db.query<LogRow, LogKey>(
    `SELECT head, first_seq AS firstSeq, deleted, epoch, owner_id AS ownerId,
       expires_at AS expiresAt, released, affinity, snapshot_seq AS snapshotSeq
     FROM logs WHERE log_id = $logId`,
  )
  const selectOffer = db.query<{ record: string; consumed: number }, OfferKey>(
    'SELECT record, consumed FROM log_offers WHERE log_id = $logId AND input_id = $inputId',
  )
  const selectChangeCount = db.query<{ changeCount: number }, LogKey>(
    'SELECT change_count AS changeCount FROM logs WHERE log_id = $logId',
  )
  const selectDataVersion = db.query<{ data_version: number }, []>(
    'PRAGMA data_version',
  )
  const changeCountOf = (logId: string) =>
    selectChangeCount.get({ logId })?.changeCount ?? 0

  /**
   * The row of `logId`, when `epoch` owns the log. Only an owner pins,
   * snapshots, and truncates, so a log that no host acquired refuses them.
   */
  const ownedLog = (logId: string, epoch: number) => {
    const log = selectLog.get({ logId })
    const isOwned =
      log !== null && epoch !== NO_OWNER_EPOCH && canWrite(log, epoch)
    if (!isOwned) throw new OwnershipLostError(logId, epoch)
    return log
  }

  /** True when the log is pinned to a live host that is not `affinity`. */
  const isPinnedElsewhere = (
    pin: string | null,
    affinity: string | undefined,
    now: number,
  ) => {
    if (pin === null || pin === affinity) return false
    const host = db
      .query<{ expiresAt: number }, { hostId: string }>(
        'SELECT expires_at AS expiresAt FROM log_hosts WHERE host_id = $hostId',
      )
      .get({ hostId: pin })
    return (host?.expiresAt ?? 0) > now
  }

  // The checks come in the order of the contract: the fence, the position,
  // the consumes, then the JSON. A throw rolls back the whole batch.
  const appendBatch = db.transaction(
    ({ logId, seq, epoch, records, consumes = [] }: AppendBatch) => {
      const log = selectLog.get({ logId })
      if (!canWrite(log, epoch)) throw new OwnershipLostError(logId, epoch)
      const head = log?.head ?? 0
      if (seq !== head + 1) throw new LogConflictError(logId, seq)
      for (const inputId of consumes) {
        const isPending = selectOffer.get({ logId, inputId })?.consumed === 0
        if (!isPending) {
          throw new TypeError(
            `Input ${JSON.stringify(inputId)} is not a pending offer of log ${JSON.stringify(logId)}.`,
          )
        }
      }
      const texts = records.map((record) => JSON.stringify(record))
      const insertRecord = db.query(
        'INSERT INTO log_records (log_id, seq, record) VALUES ($logId, $seq, $record)',
      )
      texts.forEach((record, index) => {
        insertRecord.run({ logId, seq: seq + index, record })
      })
      const consumeOffer = db.query(
        'UPDATE log_offers SET consumed = 1 WHERE log_id = $logId AND input_id = $inputId',
      )
      for (const inputId of consumes) consumeOffer.run({ logId, inputId })
      db.query(
        `INSERT INTO logs (log_id, head, change_count) VALUES ($logId, $head, 1)
         ON CONFLICT (log_id) DO UPDATE SET
           head = excluded.head, change_count = change_count + 1`,
      ).run({ logId, head: head + texts.length })
    },
  )

  // One read transaction, so a truncate in another process cannot cut the
  // records between the check and the read.
  const readRecords = db.transaction(
    (logId: string, after: number, limit: number | undefined) => {
      const firstSeq = selectLog.get({ logId })?.firstSeq ?? 1
      // The record at `after + 1` is dropped, so the page would have a hole.
      if (after < firstSeq - 1) throw new LogTruncatedError(logId, firstSeq)
      const rows = db
        .query<
          { seq: number; record: string },
          { logId: string; after: number; limit: number }
        >(
          'SELECT seq, record FROM log_records WHERE log_id = $logId AND seq > $after ORDER BY seq LIMIT $limit',
        )
        // A limit of -1 is no limit in SQLite.
        .all({ logId, after, limit: limit ?? -1 })
      return rows.map((row) => ({ seq: row.seq, record: JSON.parse(row.record) }))
    },
  )

  const acquire = db.transaction(
    ({ logId, harness, ownerId, ttlMs, affinity }: OwnershipClaim) => {
      const now = Date.now()
      const log = selectLog.get({ logId })
      const isHeld = log !== null && log.ownerId !== null && log.released === 0
      const isLive = isHeld && (log.expiresAt ?? 0) > now
      if (isLive && log.ownerId !== ownerId) return null
      if (isPinnedElsewhere(log?.affinity ?? null, affinity, now)) return null
      // The caller holds the log already: extend it at the same epoch.
      if (isLive) {
        db.query(
          'UPDATE logs SET expires_at = $expiresAt WHERE log_id = $logId',
        ).run({ logId, expiresAt: now + ttlMs })
        return { epoch: log.epoch }
      }
      const epoch = (log?.epoch ?? NO_OWNER_EPOCH) + 1
      // Another owner that did not release the log: its ownership expired.
      const expired = isHeld && log.ownerId !== ownerId
      // A new owner clears the wake time and opens a deleted log again.
      db.query(
        `INSERT INTO logs (log_id, epoch, owner_id, harness, expires_at)
         VALUES ($logId, $epoch, $ownerId, $harness, $expiresAt)
         ON CONFLICT (log_id) DO UPDATE SET
           epoch = excluded.epoch, owner_id = excluded.owner_id,
           harness = excluded.harness, expires_at = excluded.expires_at,
           released = 0, wake_at = NULL, deleted = 0`,
      ).run({ logId, epoch, ownerId, harness, expiresAt: now + ttlMs })
      return expired ? { epoch, expired: true } : { epoch }
    },
  )

  const pin = db.transaction(({ logId, epoch, affinity }: WorkerPin) => {
    ownedLog(logId, epoch)
    db.query('UPDATE logs SET affinity = $affinity WHERE log_id = $logId').run(
      { logId, affinity },
    )
  })

  const offer = db.transaction(
    ({ logId, harness, inputId, record }: OfferRow) => {
      // A late input must not start a deleted log again.
      if (selectLog.get({ logId })?.deleted === 1) return 'deleted'
      // A consumed id stays taken too.
      const previous = selectOffer.get({ logId, inputId })
      if (previous !== null) {
        return previous.record === record ? 'duplicate' : 'conflict'
      }
      db.query(
        `INSERT INTO log_offers (log_id, input_id, record, offered_at)
         VALUES ($logId, $inputId, $record, $offeredAt)`,
      ).run({ logId, inputId, record, offeredAt: Date.now() })
      // The first offer names the harness. A later offer does not change it.
      db.query(
        `INSERT INTO logs (log_id, lane_harness, change_count) VALUES ($logId, $harness, 1)
         ON CONFLICT (log_id) DO UPDATE SET
           lane_harness = COALESCE(lane_harness, excluded.lane_harness),
           change_count = change_count + 1`,
      ).run({ logId, harness })
      return 'offered'
    },
  )

  const putSnapshot = db.transaction(
    ({ logId, epoch, seq, version, state }: SnapshotWrite) => {
      const log = ownedLog(logId, epoch)
      if (seq > log.head) {
        throw new RangeError(
          `Snapshot position ${seq} is after the last position ${log.head} of log ${JSON.stringify(logId)}.`,
        )
      }
      // A reader replays the records after the snapshot. The records before
      // `firstSeq` are dropped, so the lowest snapshot is at `firstSeq - 1`.
      const lowest = log.firstSeq - 1
      if (seq < lowest) {
        throw new RangeError(
          `Snapshot position ${seq} is before position ${lowest} of log ${JSON.stringify(logId)}. The log dropped the records before ${log.firstSeq}.`,
        )
      }
      db.query(
        'UPDATE logs SET snapshot_seq = $seq, snapshot = $snapshot WHERE log_id = $logId',
      ).run({ logId, seq, snapshot: JSON.stringify({ seq, version, state }) })
    },
  )

  const truncate = db.transaction(({ logId, epoch, beforeSeq }: LogCut) => {
    const log = ownedLog(logId, epoch)
    // A reader that gets LogTruncatedError loads the snapshot, so the
    // snapshot must hold every record that the cut drops.
    const isCovered =
      log.snapshotSeq !== null && log.snapshotSeq >= beforeSeq - 1
    if (!isCovered) {
      throw new RangeError(
        `Log ${JSON.stringify(logId)} has no snapshot at position ${beforeSeq - 1} or later, so it keeps the records before ${beforeSeq}.`,
      )
    }
    // A cut before the first kept position drops nothing.
    if (beforeSeq <= log.firstSeq) return
    db.query(
      'DELETE FROM log_records WHERE log_id = $logId AND seq < $beforeSeq',
    ).run({ logId, beforeSeq })
    db.query('UPDATE logs SET first_seq = $beforeSeq WHERE log_id = $logId').run(
      { logId, beforeSeq },
    )
  })

  // The row stays, so the epoch counter stays. The log has no owner now, as
  // after a release with no wake, and every write fails until an acquire.
  const deleteLog = db.transaction((logId: string) => {
    db.query('DELETE FROM log_records WHERE log_id = $logId').run({ logId })
    db.query('DELETE FROM log_offers WHERE log_id = $logId').run({ logId })
    db.query(
      `INSERT INTO logs (log_id, deleted, change_count) VALUES ($logId, 1, 1)
       ON CONFLICT (log_id) DO UPDATE SET
         head = 0, first_seq = 1, deleted = 1, released = 1, wake_at = NULL,
         affinity = NULL, lane_harness = NULL, snapshot_seq = NULL,
         snapshot = NULL, change_count = change_count + 1`,
    ).run({ logId })
  })

  // The listeners of each log, and the change count that they saw last.
  const watches = new Map<
    string,
    { listeners: Set<() => void>; changeCount: number }
  >()
  let dataVersion = selectDataVersion.get()?.data_version
  let timer: ReturnType<typeof setInterval> | undefined

  /** Call the listeners of `logId`. A listener that throws does not stop the others. */
  const notify = (logId: string) => {
    const listeners = [...(watches.get(logId)?.listeners ?? [])]
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[heddle] log listener failed', error)
      }
    }
  }

  /**
   * Wake the listeners of this store after its own write. They saw the
   * change, so the poll does not wake them again for it.
   */
  const wake = (logId: string) => {
    const watch = watches.get(logId)
    if (watch === undefined) return
    watch.changeCount = changeCountOf(logId)
    notify(logId)
  }

  // `data_version` changes when another connection writes. Then each log
  // with listeners compares its change count.
  const poll = () => {
    try {
      const version = selectDataVersion.get()?.data_version
      if (version === dataVersion) return
      dataVersion = version
      const logIds = [...watches.keys()]
      for (const logId of logIds) {
        // A listener can stop other listeners, or close the store.
        const watch = watches.get(logId)
        if (watch === undefined) continue
        const changeCount = changeCountOf(logId)
        if (changeCount === watch.changeCount) continue
        watch.changeCount = changeCount
        notify(logId)
      }
    } catch (error) {
      console.error('[heddle] log poll failed', error)
    }
  }

  const stopPoll = () => {
    clearInterval(timer)
    timer = undefined
  }

  const stop = () => {
    stopPoll()
    watches.clear()
  }

  const store = defineLogStore({
    async append(batch) {
      const isNoop =
        batch.records.length === 0 && (batch.consumes ?? []).length === 0
      if (isNoop) return
      appendBatch.immediate(batch)
      wake(batch.logId)
    },
    async read({ logId, after = 0, limit }) {
      return readRecords(logId, after, limit)
    },
    subscribe({ logId, listener }) {
      const watch = watches.get(logId) ?? {
        listeners: new Set<() => void>(),
        changeCount: changeCountOf(logId),
      }
      watches.set(logId, watch)
      watch.listeners.add(listener)
      timer ??= setInterval(poll, POLL_MS)
      return () => {
        watch.listeners.delete(listener)
        const isLastListener =
          watch.listeners.size === 0 && watches.get(logId) === watch
        if (!isLastListener) return
        watches.delete(logId)
        // Stop the poll when nothing waits, so the process can exit.
        if (watches.size === 0) stopPoll()
      }
    },
    async acquireOwnership(claim) {
      assertTtl(claim.ttlMs)
      return acquire.immediate(claim)
    },
    async renewOwnership({ logId, ownerId, epoch, ttlMs }) {
      assertTtl(ttlMs)
      // An expired owner can renew. A new acquire would have changed the epoch.
      const renewed = db
        .query(
          `UPDATE logs SET expires_at = $expiresAt
           WHERE log_id = $logId AND owner_id = $ownerId AND epoch = $epoch AND released = 0`,
        )
        .run({ logId, ownerId, epoch, expiresAt: Date.now() + ttlMs })
      return renewed.changes === 1
    },
    async releaseOwnership({ logId, ownerId, epoch, wakeInMs }) {
      if (wakeInMs !== undefined) assertWake(wakeInMs)
      const wakeAt = wakeInMs === undefined ? null : Date.now() + wakeInMs
      db.query(
        `UPDATE logs SET released = 1, wake_at = $wakeAt
         WHERE log_id = $logId AND owner_id = $ownerId AND epoch = $epoch AND released = 0`,
      ).run({ logId, ownerId, epoch, wakeAt })
    },
    async pinToWorkers(input) {
      pin.immediate(input)
    },
    async markHostAlive({ hostId, ttlMs }) {
      assertTtl(ttlMs)
      db.query(
        `INSERT INTO log_hosts (host_id, expires_at) VALUES ($hostId, $expiresAt)
         ON CONFLICT (host_id) DO UPDATE SET expires_at = excluded.expires_at`,
      ).run({ hostId, expiresAt: Date.now() + ttlMs })
    },
    async listLogsWithoutOwner({ limit, harnesses, affinity }) {
      return db
        .query<
          OrphanedLog,
          {
            now: number
            harnesses: string | null
            affinity: string | null
            limit: number
          }
        >(ORPHANS_SQL)
        .all({
          now: Date.now(),
          harnesses: harnesses === undefined ? null : JSON.stringify(harnesses),
          affinity: affinity ?? null,
          limit,
        })
    },
    async offerInput({ logId, harness, inputId, record }) {
      // The JSON comes first, so a record that cannot become JSON stores nothing.
      const result = offer.immediate({
        logId,
        harness,
        inputId,
        record: JSON.stringify(record),
      })
      if (result === 'offered') wake(logId)
      return result
    },
    async listOfferedInputs({ logId }) {
      const rows = db
        .query<{ inputId: string; record: string; offeredAt: number }, LogKey>(
          `SELECT input_id AS inputId, record, offered_at AS offeredAt FROM log_offers
           WHERE log_id = $logId AND consumed = 0 ORDER BY position`,
        )
        .all({ logId })
      return rows.map((row) => ({ ...row, record: JSON.parse(row.record) }))
    },
    async getSnapshot({ logId }) {
      const row = db
        .query<{ snapshot: string | null }, LogKey>(
          'SELECT snapshot FROM logs WHERE log_id = $logId',
        )
        .get({ logId })
      return row === null || row.snapshot === null
        ? null
        : JSON.parse(row.snapshot)
    },
    async putSnapshot(snapshot) {
      putSnapshot.immediate(snapshot)
    },
    async truncate(cut) {
      truncate.immediate(cut)
    },
    async deleteLog({ logId }) {
      deleteLog.immediate(logId)
      wake(logId)
    },
  })
  return { store, stop }
}

type AppendBatch = Parameters<LogStore['append']>[0]
type OwnershipClaim = Parameters<LogStore['acquireOwnership']>[0]
type WorkerPin = Parameters<LogStore['pinToWorkers']>[0]
type SnapshotWrite = Parameters<LogStore['putSnapshot']>[0]
type LogCut = Parameters<LogStore['truncate']>[0]
// An offer with its record as JSON text.
type OfferRow = OfferKey & { harness: string; record: string }
type SessionKey = { tenantId: string; threadId: string }

// The cursor is `<updatedAt>:<threadId>` of the last entry of a page.
function parseSessionCursor(cursor: string) {
  const split = cursor.indexOf(':')
  const updatedAt = Number(cursor.slice(0, split))
  if (split <= 0 || !Number.isFinite(updatedAt)) {
    throw new Error(`Invalid session index cursor: ${cursor}`)
  }
  return { updatedAt, threadId: cursor.slice(split + 1) }
}

/** The session index on `db`. Each entry is kept whole, as JSON. */
function sqliteSessionStore(db: Database) {
  const select = db.query<{ entry: string; revision: string }, SessionKey>(
    'SELECT entry, revision FROM sessions WHERE tenant_id = $tenantId AND thread_id = $threadId',
  )
  // A key without `tenantId` is in the default tenant, ''.
  const keyOf = (key: SessionIndexKey) => ({
    tenantId: key.tenantId ?? '',
    threadId: key.threadId,
  })
  // Each write gets a new random revision, so a revision never comes back.
  const write = (entry: SessionIndexEntry) => {
    const revision = crypto.randomUUID()
    db.query(
      `INSERT INTO sessions (tenant_id, thread_id, updated_at, entry, revision)
       VALUES ($tenantId, $threadId, $updatedAt, $entry, $revision)
       ON CONFLICT (tenant_id, thread_id) DO UPDATE SET
         updated_at = excluded.updated_at, entry = excluded.entry,
         revision = excluded.revision`,
    ).run({
      ...keyOf(entry),
      updatedAt: entry.updatedAt,
      entry: JSON.stringify(entry),
      revision,
    })
    return revision
  }
  // The new revision, or null when another writer wrote first.
  const writeIf = db.transaction(
    (entry: SessionIndexEntry, revision: string | null) => {
      const current = select.get(keyOf(entry))?.revision ?? null
      return current === revision ? write(entry) : null
    },
  )
  return defineSessionIndexStore({
    async get(key) {
      const row = select.get(keyOf(key))
      return row === null ? undefined : JSON.parse(row.entry)
    },
    async getVersioned(key) {
      const row = select.get(keyOf(key))
      return row === null
        ? undefined
        : { entry: JSON.parse(row.entry), revision: row.revision }
    },
    async upsert(entry) {
      write(entry)
    },
    async upsertIf({ entry, revision }) {
      const written = writeIf.immediate(entry, revision)
      return written === null
        ? { ok: false, reason: 'conflict' }
        : { ok: true, revision: written }
    },
    async list(options = {}) {
      const { limit, cursor, parentThreadId, memberId, search, harness } =
        options
      const after =
        cursor === undefined ? undefined : parseSessionCursor(cursor)
      const needle = search?.toLowerCase()
      const metadata = Object.entries(options.metadata ?? {})
      // SQL sorts and applies the cursor. The filters below read the JSON.
      const rows = db
        .query<
          { entry: string },
          {
            tenantId: string
            afterTime: number | null
            afterThread: string | null
          }
        >(
          `SELECT entry FROM sessions
           WHERE tenant_id = $tenantId AND ($afterTime IS NULL
             OR updated_at < $afterTime
             OR (updated_at = $afterTime AND thread_id > $afterThread))
           ORDER BY updated_at DESC, thread_id`,
        )
        .all({
          tenantId: options.tenantId ?? '',
          afterTime: after?.updatedAt ?? null,
          afterThread: after?.threadId ?? null,
        })
      const entries: Array<SessionIndexEntry> = rows.map((row) =>
        JSON.parse(row.entry),
      )
      const matching = entries.filter((entry) => {
        // `null` asks for the entries with no parent.
        const isChild =
          parentThreadId === undefined ||
          (entry.parentThreadId ?? null) === parentThreadId
        const isMember =
          memberId === undefined ||
          entry.members.some((member) => member.userId === memberId)
        const isFound =
          needle === undefined ||
          (entry.title?.toLowerCase().includes(needle) ?? false)
        const isHarness = harness === undefined || entry.harness === harness
        const hasMetadata = metadata.every(
          ([key, value]) => entry.metadata?.[key] === value,
        )
        const isShown = options.withArchived === true || entry.archived !== true
        return (
          isChild && isMember && isFound && isHarness && hasMetadata && isShown
        )
      })
      const page = limit === undefined ? matching : matching.slice(0, limit)
      const last = page.at(-1)
      const hasMore =
        limit !== undefined && matching.length > limit && last !== undefined
      return {
        entries: page,
        ...(hasMore
          ? { cursor: `${last.updatedAt}:${last.threadId}`, truncated: true }
          : {}),
      }
    },
    async delete(key) {
      db.query(
        'DELETE FROM sessions WHERE tenant_id = $tenantId AND thread_id = $threadId',
      ).run(keyOf(key))
    },
  })
}

/** The metadata store on `db`, with compare-and-set. Values are kept as JSON. */
function sqliteMetadataStore(db: Database) {
  const select = db.query<
    { value: string; revision: string },
    { namespace: string; key: string }
  >(
    'SELECT value, revision FROM metadata WHERE namespace = $namespace AND key = $key',
  )
  // Each write gets a new random revision, so a revision never comes back.
  const write = (namespace: string, key: string, value: unknown) => {
    const revision = crypto.randomUUID()
    db.query(
      `INSERT INTO metadata (namespace, key, value, revision)
       VALUES ($namespace, $key, $value, $revision)
       ON CONFLICT (namespace, key) DO UPDATE SET
         value = excluded.value, revision = excluded.revision`,
    ).run({ namespace, key, value: JSON.stringify(value), revision })
    return revision
  }
  // The new revision, or null when the current revision is not `expected`.
  const writeIf = db.transaction(
    (namespace: string, key: string, value: unknown, expected: string | null) => {
      const current = select.get({ namespace, key })?.revision ?? null
      return current === expected ? write(namespace, key, value) : null
    },
  )
  return defineMetadataStore({
    async get(namespace, key) {
      const row = select.get({ namespace, key })
      return row === null ? null : JSON.parse(row.value)
    },
    async getVersioned(namespace, key) {
      const row = select.get({ namespace, key })
      return row === null
        ? null
        : { value: JSON.parse(row.value), revision: row.revision }
    },
    async set(namespace, key, value) {
      write(namespace, key, value)
    },
    async setIf(namespace, key, value, expectedRevision) {
      const written = writeIf.immediate(namespace, key, value, expectedRevision)
      return written === null
        ? { ok: false, reason: 'conflict' }
        : { ok: true, revision: written }
    },
    async delete(namespace, key) {
      db.query(
        'DELETE FROM metadata WHERE namespace = $namespace AND key = $key',
      ).run({ namespace, key })
    },
  })
}

/** The credential store on `db`. The key is `(tenantId ?? '', userId ?? '', id)`. */
function sqliteCredentialStore(db: Database) {
  // A credential without a user belongs to the tenant. A scope with neither
  // is one shared bucket.
  const ownerOf = (scope: CredentialScope) => ({
    tenantId: scope.tenantId ?? '',
    userId: scope.userId ?? '',
  })
  return defineCredentialStore({
    async get({ scope, id }) {
      const row = db
        .query<
          { credential: string },
          { tenantId: string; userId: string; id: string }
        >(
          'SELECT credential FROM credentials WHERE tenant_id = $tenantId AND user_id = $userId AND id = $id',
        )
        .get({ ...ownerOf(scope), id })
      return row === null ? null : JSON.parse(row.credential)
    },
    async set({ scope, id, credential }) {
      db.query(
        `INSERT INTO credentials (tenant_id, user_id, id, credential)
         VALUES ($tenantId, $userId, $id, $credential)
         ON CONFLICT (tenant_id, user_id, id) DO UPDATE SET credential = excluded.credential`,
      ).run({ ...ownerOf(scope), id, credential: JSON.stringify(credential) })
    },
    async delete({ scope, id }) {
      db.query(
        'DELETE FROM credentials WHERE tenant_id = $tenantId AND user_id = $userId AND id = $id',
      ).run({ ...ownerOf(scope), id })
    },
    // Ids and types only. The secret values stay in the file.
    async list(scope) {
      const rows = db
        .query<
          { id: string; credential: string },
          { tenantId: string; userId: string }
        >(
          'SELECT id, credential FROM credentials WHERE tenant_id = $tenantId AND user_id = $userId ORDER BY id',
        )
        .all(ownerOf(scope))
      return rows.map((row) => {
        const credential: Credential = JSON.parse(row.credential)
        const expiresAt =
          credential.type === 'api_key' ? undefined : credential.expiresAt
        return {
          id: row.id,
          type: credential.type,
          ...(expiresAt === undefined ? {} : { expiresAt }),
        }
      })
    },
  })
}
