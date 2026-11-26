import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { GAME_RESULTS, PLAYER_COLORS } from '../domain/game.types.js';

export const gameResultEnum = pgEnum('game_result', GAME_RESULTS);
export const playerColorEnum = pgEnum('player_color', PLAYER_COLORS);
export const syncStatusEnum = pgEnum('sync_status', ['running', 'success', 'failed']);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const players = pgTable(
  'players',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chesscomUsername: text('chesscom_username').notNull().unique(),
    profileUrl: text('profile_url'),
    country: text('country'),
    title: text('title'),
    name: text('name'),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    lastProfileSyncAt: timestamp('last_profile_sync_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    check(
      'players_chesscom_username_lowercase',
      sql`${table.chesscomUsername} = lower(${table.chesscomUsername})`,
    ),
  ],
);

export const games = pgTable(
  'games',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    chesscomGameUrl: text('chesscom_game_url').notNull(),
    playedAt: timestamp('played_at', { withTimezone: true }).notNull(),
    timeClass: text('time_class'),
    timeControl: text('time_control'),
    rated: boolean('rated'),
    whiteUsername: text('white_username').notNull(),
    blackUsername: text('black_username').notNull(),
    whiteRating: integer('white_rating'),
    blackRating: integer('black_rating'),
    /** Normalized from the configured player's perspective. */
    result: gameResultEnum('result').notNull(),
    /** Player's Chess.com result code; null for pre-migration rows or unknown codes. */
    playerResultCode: text('player_result_code'),
    /**
     * How the game ended (opponent loss code on wins; player's code on losses/draws).
     * Null for pre-migration rows or when only a PGN Result tag was available.
     */
    termination: text('termination'),
    playerColor: playerColorEnum('player_color').notNull(),
    opponentUsername: text('opponent_username').notNull(),
    opponentRating: integer('opponent_rating'),
    eco: text('eco'),
    openingName: text('opening_name'),
    pgn: text('pgn').notNull(),
    /** SAN move list; null when the PGN could not be parsed reliably. */
    sanMoves: jsonb('san_moves').$type<string[]>(),
    ...timestamps,
  },
  (table) => [
    // Per player: a game between two synced players is stored once from each perspective.
    uniqueIndex('games_player_game_url_key').on(table.playerId, table.chesscomGameUrl),
    index('games_player_played_at_idx').on(table.playerId, table.playedAt.desc()),
    index('games_player_time_class_played_at_idx').on(
      table.playerId,
      table.timeClass,
      table.playedAt.desc(),
    ),
    index('games_player_color_idx').on(table.playerId, table.playerColor),
    index('games_player_eco_idx').on(table.playerId, table.eco),
    index('games_player_opponent_username_idx').on(table.playerId, table.opponentUsername),
    index('games_player_rated_idx').on(table.playerId, table.rated),
    index('games_player_termination_idx').on(table.playerId, table.termination),
  ],
);

/** Per-month Chess.com archive state, so unchanged archives can be skipped via ETag. */
export const chesscomArchives = pgTable(
  'chesscom_archives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    year: integer('year').notNull(),
    month: integer('month').notNull(),
    etag: text('etag'),
    lastModified: text('last_modified'),
    /** Last time Chess.com was asked about this archive (200 or 304). */
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    /** Last time the archive was downloaded with changed content. */
    lastChangedAt: timestamp('last_changed_at', { withTimezone: true }),
    /** Games in the archive at the last download, before filtering. */
    gamesCount: integer('games_count'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('chesscom_archives_player_month_key').on(table.playerId, table.year, table.month),
    check('chesscom_archives_month_range', sql`${table.month} between 1 and 12`),
    check('chesscom_archives_year_range', sql`${table.year} between 2000 and 2100`),
  ],
);

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: syncStatusEnum('status').notNull().default('running'),
    archivesChecked: integer('archives_checked').notNull().default(0),
    gamesSeen: integer('games_seen').notNull().default(0),
    gamesInserted: integer('games_inserted').notNull().default(0),
    gamesUpdated: integer('games_updated').notNull().default(0),
    errorMessage: text('error_message'),
  },
  (table) => [index('sync_runs_player_started_at_idx').on(table.playerId, table.startedAt.desc())],
);
