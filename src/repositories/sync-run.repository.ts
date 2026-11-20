import { and, desc, eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { syncRuns } from '../db/schema.js';
import { AppError } from '../utils/errors.js';

export type SyncRunRow = typeof syncRuns.$inferSelect;

export interface SyncRunCounters {
  archivesChecked: number;
  gamesSeen: number;
  gamesInserted: number;
  gamesUpdated: number;
}

const INTERRUPTED_MESSAGE = 'Interrupted before completion (process stopped or crashed).';

export class SyncRunRepository {
  constructor(private readonly db: Db) {}

  async start(playerId: string, startedAt: Date): Promise<SyncRunRow> {
    const [row] = await this.db
      .insert(syncRuns)
      .values({ playerId, startedAt, status: 'running' })
      .returning();
    if (!row) throw new AppError('internal_error', 'Sync run could not be created.');
    return row;
  }

  async updateCounters(id: string, counters: SyncRunCounters): Promise<void> {
    await this.db.update(syncRuns).set(counters).where(eq(syncRuns.id, id));
  }

  async finish(
    id: string,
    outcome: { status: 'success' | 'failed'; finishedAt: Date; errorMessage: string | null },
    counters: SyncRunCounters,
  ): Promise<SyncRunRow> {
    const [row] = await this.db
      .update(syncRuns)
      .set({ ...counters, ...outcome })
      .where(eq(syncRuns.id, id))
      .returning();
    if (!row) throw new AppError('internal_error', 'Sync run not found.');
    return row;
  }

  /**
   * Marks runs left in `running` as failed. Only call while holding the player's sync lock,
   * which guarantees no other sync for that player is actually running.
   */
  async failInterrupted(playerId: string, finishedAt: Date): Promise<number> {
    const rows = await this.db
      .update(syncRuns)
      .set({ status: 'failed', finishedAt, errorMessage: INTERRUPTED_MESSAGE })
      .where(and(eq(syncRuns.playerId, playerId), eq(syncRuns.status, 'running')))
      .returning({ id: syncRuns.id });
    return rows.length;
  }

  async latestSuccessfulForPlayer(playerId: string): Promise<SyncRunRow | null> {
    const [row] = await this.db
      .select()
      .from(syncRuns)
      .where(and(eq(syncRuns.playerId, playerId), eq(syncRuns.status, 'success')))
      .orderBy(desc(syncRuns.startedAt))
      .limit(1);
    return row ?? null;
  }

  async latestForPlayer(playerId: string): Promise<SyncRunRow | null> {
    const [row] = await this.db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.playerId, playerId))
      .orderBy(desc(syncRuns.startedAt))
      .limit(1);
    return row ?? null;
  }
}
