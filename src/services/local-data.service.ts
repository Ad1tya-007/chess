import type { ArchiveRepository } from '../repositories/archive.repository.js';
import type { GameRepository } from '../repositories/game.repository.js';
import type { PlayerRepository, PlayerRow } from '../repositories/player.repository.js';
import type { SyncRunRepository } from '../repositories/sync-run.repository.js';
import { formatArchiveMonth } from '../utils/dates.js';

/** Local data older than this triggers a staleness warning. */
export const STALE_AFTER_HOURS = 24;

export interface LocalDataStatus {
  username: string;
  player: PlayerRow | null;
  gamesStored: number;
  firstGameAt: Date | null;
  lastGameAt: Date | null;
  /** Monthly archives downloaded at least once. */
  syncedMonths: number;
  earliestSyncedMonth: string | null;
  latestSyncedMonth: string | null;
  lastSuccessfulSyncAt: Date | null;
  lastSync: {
    status: 'running' | 'success' | 'failed';
    startedAt: Date;
    finishedAt: Date | null;
    /** True for a completed sync in which some months failed. */
    partial: boolean;
  } | null;
  warnings: string[];
}

export interface LocalDataServiceDependencies {
  players: PlayerRepository;
  games: GameRepository;
  archives: ArchiveRepository;
  syncRuns: SyncRunRepository;
  now?: () => Date;
}

/** Describes what has been synchronized locally for a player and warns about gaps. */
export class LocalDataService {
  private readonly now: () => Date;

  constructor(private readonly deps: LocalDataServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async describe(username: string): Promise<LocalDataStatus> {
    const player = await this.deps.players.findByUsername(username);
    if (!player) return emptyStatus(username);

    const [coverage, archives, lastRun, lastSuccess] = await Promise.all([
      this.deps.games.coverage(player.id),
      this.deps.archives.listForPlayer(player.id),
      this.deps.syncRuns.latestForPlayer(player.id),
      this.deps.syncRuns.latestSuccessfulForPlayer(player.id),
    ]);
    const synced = archives.filter((archive) => archive.lastChangedAt !== null);

    const status: LocalDataStatus = {
      username,
      player,
      gamesStored: coverage.games,
      firstGameAt: coverage.firstPlayedAt,
      lastGameAt: coverage.lastPlayedAt,
      syncedMonths: synced.length,
      earliestSyncedMonth: synced[0] ? formatArchiveMonth(synced[0]) : null,
      latestSyncedMonth: synced.at(-1) ? formatArchiveMonth(synced.at(-1)!) : null,
      lastSuccessfulSyncAt: lastSuccess?.finishedAt ?? null,
      lastSync: lastRun
        ? {
            status: lastRun.status,
            startedAt: lastRun.startedAt,
            finishedAt: lastRun.finishedAt,
            partial: lastRun.status === 'success' && lastRun.errorMessage !== null,
          }
        : null,
      warnings: [],
    };

    if (coverage.games === 0) {
      status.warnings.push(notSyncedWarning(username));
    }
    if (lastRun?.status === 'running') {
      status.warnings.push('A sync is in progress; results may change when it finishes.');
    } else if (lastRun?.status === 'failed') {
      status.warnings.push(
        `The most recent sync failed${lastRun.errorMessage ? `: ${lastRun.errorMessage}` : '.'}`,
      );
    } else if (status.lastSync?.partial) {
      status.warnings.push(
        `The most recent sync was partial (some months failed): ${lastRun!.errorMessage}`,
      );
    }
    if (coverage.games > 0 && status.lastSuccessfulSyncAt) {
      const ageHours = (this.now().getTime() - status.lastSuccessfulSyncAt.getTime()) / 3_600_000;
      if (ageHours > STALE_AFTER_HOURS) {
        status.warnings.push(
          `Local data was last synchronized ${describeAge(ageHours)} ago; recent games may be ` +
            'missing. Call sync_chesscom_games (mode "incremental") to refresh.',
        );
      }
    }
    return status;
  }

  /** Warns when a requested range starts before the earliest synchronized month. */
  rangeWarnings(status: LocalDataStatus, from: Date | undefined): string[] {
    if (!from || !status.earliestSyncedMonth || status.gamesStored === 0) return [];
    const fromMonth = from.toISOString().slice(0, 7);
    if (fromMonth >= status.earliestSyncedMonth) return [];
    return [
      `The requested range starts in ${fromMonth}, but games are only synchronized from ` +
        `${status.earliestSyncedMonth}. Call sync_chesscom_games (mode "initial") to import ` +
        'older months.',
    ];
  }
}

export function notSyncedWarning(username: string): string {
  return (
    `No games have been synchronized for "${username}". ` +
    'Call sync_chesscom_games (mode "initial") first.'
  );
}

function emptyStatus(username: string): LocalDataStatus {
  return {
    username,
    player: null,
    gamesStored: 0,
    firstGameAt: null,
    lastGameAt: null,
    syncedMonths: 0,
    earliestSyncedMonth: null,
    latestSyncedMonth: null,
    lastSuccessfulSyncAt: null,
    lastSync: null,
    warnings: [notSyncedWarning(username)],
  };
}

function describeAge(hours: number): string {
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}
