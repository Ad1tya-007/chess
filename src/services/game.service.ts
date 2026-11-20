import type { GameResult, PlayerColor, TimeClass } from '../domain/game.types.js';
import type { GameRepository, GameRow, GameSummaryRow } from '../repositories/game.repository.js';
import { resolveUsername } from '../utils/chesscom-username.js';
import { AppError } from '../utils/errors.js';
import { canonicalGameUrl } from '../utils/game-url.js';
import type { LocalDataService, LocalDataStatus } from './local-data.service.js';

export const MAX_GAME_LIMIT = 100;
export const MAX_GAME_OFFSET = 10_000;

export interface RecentGamesQuery {
  username?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  timeClass?: TimeClass | undefined;
  result?: GameResult | undefined;
  color?: PlayerColor | undefined;
  /** Inclusive. */
  from?: Date | undefined;
  /** Exclusive. */
  until?: Date | undefined;
}

export interface RecentGames {
  username: string;
  games: GameSummaryRow[];
  totalMatching: number;
  limit: number;
  offset: number;
  local: LocalDataStatus;
  warnings: string[];
}

export interface GameDetails {
  username: string;
  game: GameRow;
  local: LocalDataStatus;
}

export interface GameServiceDependencies {
  games: GameRepository;
  localData: LocalDataService;
  defaultUsername: string;
  defaultLimit: number;
}

/** Reads synchronized games from the local database only. */
export class GameService {
  constructor(private readonly deps: GameServiceDependencies) {}

  async getRecentGames(query: RecentGamesQuery = {}): Promise<RecentGames> {
    const username = resolveUsername(query.username, this.deps.defaultUsername);
    const limit = query.limit ?? this.deps.defaultLimit;
    const offset = query.offset ?? 0;
    assertInteger('limit', limit, 1, MAX_GAME_LIMIT);
    assertInteger('offset', offset, 0, MAX_GAME_OFFSET);
    assertRange(query.from, query.until);

    const local = await this.deps.localData.describe(username);
    const warnings = [...local.warnings, ...this.deps.localData.rangeWarnings(local, query.from)];
    if (!local.player || local.gamesStored === 0) {
      return { username, games: [], totalMatching: 0, limit, offset, local, warnings };
    }

    const filters = {
      timeClass: query.timeClass,
      result: query.result,
      color: query.color,
      from: query.from,
      until: query.until,
    };
    const [games, totalMatching] = await Promise.all([
      this.deps.games.listSummaries(local.player.id, filters, { limit, offset }),
      this.deps.games.countMatching(local.player.id, filters),
    ]);
    return { username, games, totalMatching, limit, offset, local, warnings };
  }

  async getGameDetails(gameUrl: string, username?: string): Promise<GameDetails> {
    const resolved = resolveUsername(username, this.deps.defaultUsername);
    const canonical = canonicalGameUrl(gameUrl);
    if (!canonical) {
      throw new AppError(
        'invalid_input',
        'game_url must be a Chess.com game URL like https://www.chess.com/game/live/123456789.',
      );
    }

    const local = await this.deps.localData.describe(resolved);
    const game = local.player ? await this.deps.games.findByUrl(local.player.id, canonical) : null;
    if (!game) {
      throw new AppError(
        'game_not_found',
        `No synchronized game with URL ${canonical} was found for "${resolved}". Only games ` +
          'already stored by sync_chesscom_games can be retrieved; this tool never fetches URLs. ' +
          'Sync the month the game was played in first (mode "incremental" for recent months, ' +
          '"initial" for older ones).',
      );
    }
    return { username: resolved, game, local };
  }
}

export function assertInteger(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AppError('invalid_input', `${name} must be an integer between ${min} and ${max}.`);
  }
}

export function assertRange(from: Date | undefined, until: Date | undefined): void {
  if (from && until && from.getTime() >= until.getTime()) {
    throw new AppError('invalid_input', 'from_date must be before to_date.');
  }
}
