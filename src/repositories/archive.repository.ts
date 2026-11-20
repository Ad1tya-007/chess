import { and, asc, eq, sql } from 'drizzle-orm';

import type { Db, DbExecutor } from '../db/client.js';
import { chesscomArchives } from '../db/schema.js';

export type ArchiveRow = typeof chesscomArchives.$inferSelect;

export interface ArchiveKey {
  year: number;
  month: number;
}

export type ArchiveCheck =
  | {
      changed: true;
      etag: string | null;
      lastModified: string | null;
      checkedAt: Date;
      gamesCount: number;
    }
  | { changed: false; etag: string | null; lastModified: string | null; checkedAt: Date };

export class ArchiveRepository {
  constructor(private readonly db: Db) {}

  async find(playerId: string, { year, month }: ArchiveKey): Promise<ArchiveRow | null> {
    const [row] = await this.db
      .select()
      .from(chesscomArchives)
      .where(
        and(
          eq(chesscomArchives.playerId, playerId),
          eq(chesscomArchives.year, year),
          eq(chesscomArchives.month, month),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async listForPlayer(playerId: string): Promise<ArchiveRow[]> {
    return this.db
      .select()
      .from(chesscomArchives)
      .where(eq(chesscomArchives.playerId, playerId))
      .orderBy(asc(chesscomArchives.year), asc(chesscomArchives.month));
  }

  /**
   * Records the outcome of asking Chess.com for an archive. A 304 (`changed: false`) refreshes
   * the check time and keeps known validators unless Chess.com sent new ones.
   */
  async recordCheck(
    playerId: string,
    { year, month }: ArchiveKey,
    check: ArchiveCheck,
    executor: DbExecutor = this.db,
  ): Promise<ArchiveRow> {
    const changedFields = check.changed
      ? { lastChangedAt: check.checkedAt, gamesCount: check.gamesCount }
      : {};

    const [row] = await executor
      .insert(chesscomArchives)
      .values({
        playerId,
        year,
        month,
        etag: check.etag,
        lastModified: check.lastModified,
        lastCheckedAt: check.checkedAt,
        ...changedFields,
      })
      .onConflictDoUpdate({
        target: [chesscomArchives.playerId, chesscomArchives.year, chesscomArchives.month],
        set: {
          etag: check.changed ? check.etag : sql`coalesce(excluded.etag, ${chesscomArchives.etag})`,
          lastModified: check.changed
            ? check.lastModified
            : sql`coalesce(excluded.last_modified, ${chesscomArchives.lastModified})`,
          lastCheckedAt: check.checkedAt,
          ...changedFields,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return row!;
  }
}
