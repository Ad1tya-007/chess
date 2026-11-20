import { ChessComClient } from '../clients/chesscom.client.js';
import type { Config } from '../config/env.js';
import type { Database } from '../db/client.js';
import { ArchiveRepository } from '../repositories/archive.repository.js';
import { GameRepository } from '../repositories/game.repository.js';
import { PlayerRepository } from '../repositories/player.repository.js';
import { SyncRunRepository } from '../repositories/sync-run.repository.js';
import type { Logger } from '../utils/logger.js';
import { AnalyticsService } from './analytics.service.js';
import { GameService } from './game.service.js';
import { LocalDataService } from './local-data.service.js';
import { PlayerService } from './player.service.js';
import { SyncService } from './sync.service.js';

export interface Services {
  chessCom: ChessComClient;
  repositories: {
    players: PlayerRepository;
    games: GameRepository;
    archives: ArchiveRepository;
    syncRuns: SyncRunRepository;
  };
  localData: LocalDataService;
  player: PlayerService;
  sync: SyncService;
  games: GameService;
  analytics: AnalyticsService;
}

/** Builds long-lived services once per process; MCP servers created per request share them. */
export function createServices(
  config: Config,
  database: Database,
  logger: Logger,
  overrides: { chessCom?: ChessComClient; now?: () => Date } = {},
): Services {
  const chessCom =
    overrides.chessCom ??
    new ChessComClient({
      userAgent: config.CHESSCOM_USER_AGENT,
      timeoutMs: config.REQUEST_TIMEOUT_MS,
      logger: logger.child({ component: 'chesscom' }),
    });
  const now = overrides.now;
  const defaultUsername = config.CHESSCOM_USERNAME;

  const repositories = {
    players: new PlayerRepository(database.db),
    games: new GameRepository(database.db),
    archives: new ArchiveRepository(database.db),
    syncRuns: new SyncRunRepository(database.db),
  };
  const localData = new LocalDataService({ ...repositories, ...(now ? { now } : {}) });

  return {
    chessCom,
    repositories,
    localData,
    player: new PlayerService({ client: chessCom, localData, defaultUsername }),
    sync: new SyncService({
      database,
      client: chessCom,
      ...repositories,
      logger: logger.child({ component: 'sync' }),
      defaultUsername,
      maxMonthsPerCall: config.MAX_SYNC_MONTHS_PER_CALL,
      cooldownSeconds: config.SYNC_COOLDOWN_SECONDS,
      ...(now ? { now } : {}),
    }),
    games: new GameService({
      games: repositories.games,
      localData,
      defaultUsername,
      defaultLimit: config.DEFAULT_GAME_LIMIT,
    }),
    analytics: new AnalyticsService({
      games: repositories.games,
      localData,
      defaultUsername,
      ...(now ? { now } : {}),
    }),
  };
}
