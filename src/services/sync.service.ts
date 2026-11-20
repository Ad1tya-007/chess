import type { ChessComClient } from '../clients/chesscom.client.js';
import type { ArchiveMonth } from '../clients/chesscom.schemas.js';
import type { Database } from '../db/client.js';
import { normalizeArchiveGames } from '../domain/game-normalizer.js';
import type { ArchiveRepository } from '../repositories/archive.repository.js';
import type { GameRepository } from '../repositories/game.repository.js';
import type { PlayerRepository } from '../repositories/player.repository.js';
import type { SyncRunCounters, SyncRunRepository } from '../repositories/sync-run.repository.js';
import { resolveUsername } from '../utils/chesscom-username.js';
import { formatArchiveMonth } from '../utils/dates.js';
import { AppError, ChessComApiError, type ChessComErrorKind } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';

/** Advisory-lock namespace for per-player syncs (arbitrary constant, unique within this app). */
const SYNC_LOCK_NAMESPACE = 0x5c4e5;
const MAX_REPORTED_WARNINGS = 20;
export const DEFAULT_SYNC_MONTHS = 3;

/**
 * - `incremental`: re-check the newest N monthly archives. Unchanged months cost one 304 each.
 * - `initial`: import the newest N months that have never been downloaded; call again to continue
 *   further back in history.
 */
export type SyncMode = 'initial' | 'incremental';

export interface SyncOptions {
  /** Defaults to the configured CHESSCOM_USERNAME. */
  username?: string;
  /** Archives to process in this call; 1..maxMonthsPerCall. */
  months?: number;
  mode?: SyncMode;
}

export interface ArchiveFailure {
  archive: string;
  kind: ChessComErrorKind;
  message: string;
}

export interface SyncReport {
  syncRunId: string;
  username: string;
  mode: SyncMode;
  /** `partial`: completed, but some archives failed or were not attempted. */
  status: 'success' | 'partial';
  startedAt: Date;
  finishedAt: Date;
  monthsRequested: number;
  archivesAvailable: number;
  archivesChecked: number;
  archivesDownloaded: number;
  archivesNotModified: number;
  archivesFailed: number;
  /** Selected archives not attempted because Chess.com became unavailable or rate-limited. */
  archivesNotAttempted: number;
  /** Games present in downloaded archives, before filtering. */
  gamesFetched: number;
  gamesInserted: number;
  gamesUpdated: number;
  gamesUnchanged: number;
  /** Games not stored: unparseable entries, variants, unknown/conflicting results. */
  gamesSkipped: number;
  /** Archive months processed in this call (YYYY-MM), oldest and newest. */
  coverage: { from: string; to: string } | null;
  /** Archives that have never been downloaded; run `initial` again to import them. */
  archivesRemaining: number;
  failures: ArchiveFailure[];
  warnings: string[];
}

export interface SyncServiceDependencies {
  database: Database;
  client: ChessComClient;
  players: PlayerRepository;
  games: GameRepository;
  archives: ArchiveRepository;
  syncRuns: SyncRunRepository;
  logger: Logger;
  defaultUsername: string;
  maxMonthsPerCall: number;
  /** Minimum time between the end of one sync and the start of the next for a player. */
  cooldownSeconds?: number;
  now?: () => Date;
}

/** Errors after which further archive requests in this run would only fail the same way. */
const STOP_KINDS: ReadonlySet<ChessComErrorKind> = new Set(['rate_limited', 'network', 'timeout']);

const archiveKey = ({ year, month }: ArchiveMonth) => year * 100 + month;

export class SyncService {
  private readonly now: () => Date;

  constructor(private readonly deps: SyncServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async sync(options: SyncOptions = {}): Promise<SyncReport> {
    const username = resolveUsername(options.username, this.deps.defaultUsername);

    const months = options.months ?? Math.min(DEFAULT_SYNC_MONTHS, this.deps.maxMonthsPerCall);
    if (!Number.isInteger(months) || months < 1 || months > this.deps.maxMonthsPerCall) {
      throw new AppError(
        'invalid_input',
        `months must be an integer between 1 and ${this.deps.maxMonthsPerCall}.`,
      );
    }
    const mode = options.mode ?? 'incremental';

    const player = await this.deps.players.getOrCreate(username);
    const locked = await this.deps.database.tryWithAdvisoryLock(
      SYNC_LOCK_NAMESPACE,
      player.id,
      () => this.runLocked(player.id, username, mode, months),
    );
    if (!locked.acquired) {
      throw new AppError(
        'sync_in_progress',
        `A sync for "${username}" is already running. Wait for it to finish, then try again.`,
      );
    }
    return locked.value;
  }

  /** Rejects a sync that starts within `cooldownSeconds` of the player's last finished sync. */
  private async enforceCooldown(playerId: string, username: string, now: Date): Promise<void> {
    const cooldownMs = (this.deps.cooldownSeconds ?? 0) * 1000;
    if (cooldownMs <= 0) return;
    const last = await this.deps.syncRuns.latestForPlayer(playerId);
    if (!last?.finishedAt) return;
    const waitMs = last.finishedAt.getTime() + cooldownMs - now.getTime();
    if (waitMs > 0) {
      throw new AppError(
        'sync_cooldown',
        `A sync for "${username}" finished moments ago. Wait ${Math.ceil(waitMs / 1000)} ` +
          'seconds before syncing again.',
      );
    }
  }

  private async runLocked(
    playerId: string,
    username: string,
    mode: SyncMode,
    months: number,
  ): Promise<SyncReport> {
    const { client, players, syncRuns, logger } = this.deps;
    const startedAt = this.now();
    await this.enforceCooldown(playerId, username, startedAt);
    const interrupted = await syncRuns.failInterrupted(playerId, startedAt);
    if (interrupted > 0)
      logger.warn({ username, interrupted }, 'Marked interrupted sync runs as failed');

    const run = await syncRuns.start(playerId, startedAt);
    const counters: SyncRunCounters = {
      archivesChecked: 0,
      gamesSeen: 0,
      gamesInserted: 0,
      gamesUpdated: 0,
    };
    logger.info({ username, mode, months, syncRunId: run.id }, 'Sync started');

    try {
      const warnings: string[] = [];

      try {
        const profile = await client.getPlayerProfile(username);
        await players.updateProfile(
          playerId,
          {
            profileUrl: profile.data.profileUrl,
            country: profile.data.countryCode,
            title: profile.data.title,
            name: profile.data.name,
            joinedAt: profile.data.joinedAt,
          },
          profile.fetchedAt,
        );
      } catch (error) {
        // An unknown player is fatal; other profile problems should not block game import.
        if (error instanceof ChessComApiError && error.kind !== 'not_found') {
          warnings.push(`Profile not refreshed: ${error.message}`);
        } else {
          throw error;
        }
      }

      const archiveList = await client.getArchiveList(username);
      const available = archiveList.data.archives;
      if (archiveList.data.ignoredEntries > 0) {
        warnings.push(`Ignored ${archiveList.data.ignoredEntries} malformed archive entries.`);
      }

      const known = new Map(
        (await this.deps.archives.listForPlayer(playerId)).map((row) => [archiveKey(row), row]),
      );
      const downloaded = new Set(
        [...known.entries()].filter(([, row]) => row.lastChangedAt !== null).map(([key]) => key),
      );

      const newestFirst = [...available].reverse();
      const selected = (
        mode === 'initial'
          ? newestFirst.filter((archive) => !downloaded.has(archiveKey(archive)))
          : newestFirst
      ).slice(0, months);

      const report = {
        processed: [] as ArchiveMonth[],
        downloaded: 0,
        notModified: 0,
        notAttempted: 0,
        unchanged: 0,
        skipped: 0,
        failures: [] as ArchiveFailure[],
      };

      for (const [index, archive] of selected.entries()) {
        const label = formatArchiveMonth(archive);
        const previous = known.get(archiveKey(archive));
        const validators =
          previous && previous.lastChangedAt !== null
            ? { etag: previous.etag, lastModified: previous.lastModified }
            : undefined;

        try {
          const result = await client.getArchiveGames(username, archive, validators);
          counters.archivesChecked += 1;

          if (result.status === 'not_modified') {
            await this.deps.archives.recordCheck(playerId, archive, {
              changed: false,
              ...result.validators,
              checkedAt: result.fetchedAt,
            });
            report.notModified += 1;
          } else {
            const normalized = normalizeArchiveGames(result.data.games, username);
            const upsert = await this.deps.database.db.transaction(async (tx) => {
              const counts = await this.deps.games.upsertMany(playerId, normalized.games, tx);
              await this.deps.archives.recordCheck(
                playerId,
                archive,
                {
                  changed: true,
                  ...result.validators,
                  checkedAt: result.fetchedAt,
                  gamesCount: result.data.games.length,
                },
                tx,
              );
              return counts;
            });

            report.downloaded += 1;
            counters.gamesSeen += result.data.games.length;
            counters.gamesInserted += upsert.inserted;
            counters.gamesUpdated += upsert.updated;
            report.unchanged += upsert.unchanged;
            report.skipped += result.data.skipped.length + normalized.rejected.length;
            downloaded.add(archiveKey(archive));

            if (result.data.skipped.length > 0) {
              warnings.push(
                `${label}: ${result.data.skipped.length} malformed game entries skipped.`,
              );
            }
            for (const rejected of normalized.rejected) {
              warnings.push(`${label}: ${rejected.url} not stored. ${rejected.reason}`);
            }
            for (const warning of normalized.warnings) warnings.push(`${label}: ${warning}`);
          }
          report.processed.push(archive);
        } catch (error) {
          if (!(error instanceof ChessComApiError)) throw error;
          report.failures.push({ archive: label, kind: error.kind, message: error.message });
          logger.warn({ username, archive: label, kind: error.kind }, 'Archive sync failed');
          if (STOP_KINDS.has(error.kind)) {
            report.notAttempted = selected.length - index - 1;
            break;
          }
        }

        await syncRuns.updateCounters(run.id, counters);
      }

      const finishedAt = this.now();
      const status = report.failures.length > 0 ? 'partial' : 'success';
      const errorMessage =
        report.failures.length > 0
          ? report.failures.map((failure) => `${failure.archive}: ${failure.message}`).join(' ')
          : null;
      await syncRuns.finish(run.id, { status: 'success', finishedAt, errorMessage }, counters);

      const sortedProcessed = [...report.processed].sort((a, b) => archiveKey(a) - archiveKey(b));
      const result: SyncReport = {
        syncRunId: run.id,
        username,
        mode,
        status,
        startedAt,
        finishedAt,
        monthsRequested: months,
        archivesAvailable: available.length,
        archivesChecked: counters.archivesChecked,
        archivesDownloaded: report.downloaded,
        archivesNotModified: report.notModified,
        archivesFailed: report.failures.length,
        archivesNotAttempted: report.notAttempted,
        gamesFetched: counters.gamesSeen,
        gamesInserted: counters.gamesInserted,
        gamesUpdated: counters.gamesUpdated,
        gamesUnchanged: report.unchanged,
        gamesSkipped: report.skipped,
        coverage:
          sortedProcessed.length > 0
            ? {
                from: formatArchiveMonth(sortedProcessed[0]!),
                to: formatArchiveMonth(sortedProcessed.at(-1)!),
              }
            : null,
        archivesRemaining: available.filter((archive) => !downloaded.has(archiveKey(archive)))
          .length,
        failures: report.failures,
        warnings: boundWarnings(warnings),
      };
      logger.info(
        {
          username,
          syncRunId: run.id,
          status,
          archivesChecked: result.archivesChecked,
          gamesInserted: result.gamesInserted,
          gamesUpdated: result.gamesUpdated,
          archivesFailed: result.archivesFailed,
        },
        'Sync finished',
      );
      return result;
    } catch (error) {
      const message =
        error instanceof AppError ? error.message : 'Sync failed due to an internal error.';
      await syncRuns
        .finish(
          run.id,
          { status: 'failed', finishedAt: this.now(), errorMessage: message },
          counters,
        )
        .catch((finishError: Error) =>
          logger.error({ err: { message: finishError.message } }, 'Could not record sync failure'),
        );
      logger.error(
        { username, syncRunId: run.id, err: { message: (error as Error).message } },
        'Sync failed',
      );
      throw error instanceof AppError
        ? error
        : new AppError('internal_error', message, { cause: error });
    }
  }
}

function boundWarnings(warnings: string[]): string[] {
  if (warnings.length <= MAX_REPORTED_WARNINGS) return warnings;
  return [
    ...warnings.slice(0, MAX_REPORTED_WARNINGS),
    `…and ${warnings.length - MAX_REPORTED_WARNINGS} more warnings.`,
  ];
}
