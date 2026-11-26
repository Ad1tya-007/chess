import {
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
} from '@modelcontextprotocol/server';

import type { Config } from '../config/env.js';
import type { Services } from '../services/create-services.js';
import { resolveUsername } from '../utils/chesscom-username.js';
import type { Logger } from '../utils/logger.js';
import {
  dataCoverageWire,
  iso,
  SOURCE_CHESSCOM,
  SOURCE_LOCAL,
  type UsernamePolicy,
} from './tools/shared.js';

const MIME_JSON = 'application/json';

const KIND_COVERAGE = 'coverage';
const KIND_LAST_SYNC = 'last-sync';
const KIND_PROFILE = 'profile';

type ResourceKind = typeof KIND_COVERAGE | typeof KIND_LAST_SYNC | typeof KIND_PROFILE;

function playerResourceUri(username: string, kind: ResourceKind): string {
  return `chess://player/${username}/${kind}`;
}

function jsonResource(uri: string, data: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: MIME_JSON,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function singleVariable(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Resolves the `{username}` variable from a resource URI against the username lock.
 * Throws ResourceNotFoundError for invalid or disallowed usernames.
 */
function resolveResourceUsername(
  raw: string | string[] | undefined,
  users: UsernamePolicy,
  defaultUsername: string,
): string {
  const username = singleVariable(raw);
  if (!username) {
    throw new ResourceNotFoundError('Resource URI is missing a Chess.com username.');
  }
  try {
    users.check(username);
    return resolveUsername(username, defaultUsername);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Username not allowed.';
    throw new ResourceNotFoundError(message);
  }
}

export interface ResourceDependencies {
  config: Config;
  services: Services;
  users: UsernamePolicy;
  logger: Logger;
}

/** Registers coverage, last-sync, and profile MCP resources for the configured player. */
export function registerPlayerResources(
  server: McpServer,
  { config, services, users, logger }: ResourceDependencies,
): void {
  const defaultUsername = config.CHESSCOM_USERNAME;
  const resourceLogger = logger.child({ component: 'resources' });

  const listForKind = (kind: ResourceKind, title: string, description: string) => () => ({
    resources: [
      {
        uri: playerResourceUri(defaultUsername, kind),
        name: `${kind}:${defaultUsername}`,
        title,
        description,
        mimeType: MIME_JSON,
      },
    ],
  });

  server.registerResource(
    'player-coverage',
    new ResourceTemplate(`chess://player/{username}/${KIND_COVERAGE}`, {
      list: listForKind(
        KIND_COVERAGE,
        'Local sync coverage',
        'Games stored, synced months, and last successful sync for this player.',
      ),
    }),
    {
      title: 'Local sync coverage',
      description:
        'What has been synchronized into the local database for a Chess.com player: game count, ' +
        'month coverage, last sync status, and data-quality warnings.',
      mimeType: MIME_JSON,
    },
    async (uri, variables) => {
      const username = resolveResourceUsername(variables.username, users, defaultUsername);
      resourceLogger.info({ resource: KIND_COVERAGE, username }, 'Resource read');
      const local = await services.localData.describe(username);
      return jsonResource(uri.href, {
        username,
        source: SOURCE_LOCAL,
        generated_at: iso(new Date()),
        data_coverage: dataCoverageWire(local),
        warnings: local.warnings,
      });
    },
  );

  server.registerResource(
    'player-last-sync',
    new ResourceTemplate(`chess://player/{username}/${KIND_LAST_SYNC}`, {
      list: listForKind(
        KIND_LAST_SYNC,
        'Last sync run',
        'Most recent sync_runs row and last successful sync timestamp.',
      ),
    }),
    {
      title: 'Last sync run',
      description:
        'Status of the most recent sync for a Chess.com player (running/success/failed), ' +
        'counters, and when the last successful sync finished.',
      mimeType: MIME_JSON,
    },
    async (uri, variables) => {
      const username = resolveResourceUsername(variables.username, users, defaultUsername);
      resourceLogger.info({ resource: KIND_LAST_SYNC, username }, 'Resource read');
      const local = await services.localData.describe(username);
      const player = local.player;
      const lastRun = player
        ? await services.repositories.syncRuns.latestForPlayer(player.id)
        : null;

      return jsonResource(uri.href, {
        username,
        source: SOURCE_LOCAL,
        generated_at: iso(new Date()),
        last_successful_sync_at: iso(local.lastSuccessfulSyncAt),
        last_sync: local.lastSync
          ? {
              status: local.lastSync.status,
              partial: local.lastSync.partial,
              started_at: iso(local.lastSync.startedAt),
              finished_at: iso(local.lastSync.finishedAt),
            }
          : null,
        last_run: lastRun
          ? {
              id: lastRun.id,
              status: lastRun.status,
              started_at: iso(lastRun.startedAt),
              finished_at: iso(lastRun.finishedAt),
              archives_checked: lastRun.archivesChecked,
              games_seen: lastRun.gamesSeen,
              games_inserted: lastRun.gamesInserted,
              games_updated: lastRun.gamesUpdated,
              error_message: lastRun.errorMessage,
            }
          : null,
        warnings: local.warnings,
      });
    },
  );

  server.registerResource(
    'player-profile',
    new ResourceTemplate(`chess://player/{username}/${KIND_PROFILE}`, {
      list: listForKind(
        KIND_PROFILE,
        'Chess.com profile snapshot',
        'Live (or cached) public Chess.com profile plus local coverage.',
      ),
    }),
    {
      title: 'Chess.com profile snapshot',
      description:
        'Public Chess.com profile fields fetched live from the PubAPI (or served from the ' +
        'client cache), plus a snapshot of what is synchronized locally. Prefer get_player_profile ' +
        'when you need the tool response shape.',
      mimeType: MIME_JSON,
    },
    async (uri, variables) => {
      const username = resolveResourceUsername(variables.username, users, defaultUsername);
      resourceLogger.info({ resource: KIND_PROFILE, username }, 'Resource read');
      const result = await services.player.getProfile(username);
      const profile = result.data;
      return jsonResource(uri.href, {
        username: result.username,
        source: SOURCE_CHESSCOM,
        generated_at: iso(new Date()),
        fetched_at: iso(result.fetchedAt),
        cache: result.cache,
        profile: {
          username: profile.username,
          name: profile.name,
          title: profile.title,
          status: profile.status,
          country_code: profile.countryCode,
          location: profile.location,
          profile_url: profile.profileUrl,
          joined_at: iso(profile.joinedAt),
          last_online_at: iso(profile.lastOnlineAt),
          followers: profile.followers,
          fide_rating: profile.fideRating,
          is_streamer: profile.isStreamer,
          league: profile.league,
        },
        local_data: dataCoverageWire(result.local),
        warnings: result.local.warnings,
      });
    },
  );
}
