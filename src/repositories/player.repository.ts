import { eq } from 'drizzle-orm';

import type { Db, DbExecutor } from '../db/client.js';
import { players } from '../db/schema.js';
import { normalizeChessComUsername } from '../utils/chesscom-username.js';
import { AppError } from '../utils/errors.js';

export type PlayerRow = typeof players.$inferSelect;

export interface PlayerProfileFields {
  profileUrl: string | null;
  country: string | null;
  title: string | null;
  name: string | null;
  joinedAt: Date | null;
}

function requireUsername(username: string): string {
  const normalized = normalizeChessComUsername(username);
  if (!normalized) throw new AppError('invalid_input', 'Invalid Chess.com username.');
  return normalized;
}

export class PlayerRepository {
  constructor(private readonly db: Db) {}

  async findByUsername(
    username: string,
    executor: DbExecutor = this.db,
  ): Promise<PlayerRow | null> {
    const [row] = await executor
      .select()
      .from(players)
      .where(eq(players.chesscomUsername, requireUsername(username)))
      .limit(1);
    return row ?? null;
  }

  /** Returns the player row for `username`, creating it on first use. Safe under concurrency. */
  async getOrCreate(username: string, executor: DbExecutor = this.db): Promise<PlayerRow> {
    const chesscomUsername = requireUsername(username);
    const [inserted] = await executor
      .insert(players)
      .values({ chesscomUsername })
      .onConflictDoNothing({ target: players.chesscomUsername })
      .returning();
    if (inserted) return inserted;

    const existing = await this.findByUsername(chesscomUsername, executor);
    if (!existing) throw new AppError('internal_error', 'Player could not be loaded.');
    return existing;
  }

  async updateProfile(
    playerId: string,
    profile: PlayerProfileFields,
    syncedAt: Date,
    executor: DbExecutor = this.db,
  ): Promise<PlayerRow> {
    const [row] = await executor
      .update(players)
      .set({ ...profile, lastProfileSyncAt: syncedAt })
      .where(eq(players.id, playerId))
      .returning();
    if (!row) throw new AppError('not_found', 'Player not found.');
    return row;
  }
}
