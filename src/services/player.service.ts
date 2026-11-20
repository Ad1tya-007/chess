import type { ChessComClient, Fetched } from '../clients/chesscom.client.js';
import type { ChessComProfile, ChessComStats } from '../clients/chesscom.schemas.js';
import { resolveUsername } from '../utils/chesscom-username.js';
import type { LocalDataService, LocalDataStatus } from './local-data.service.js';

export interface PlayerLookup<T> {
  username: string;
  data: T;
  fetchedAt: Date;
  /** How the client satisfied the request: fresh download, 304 revalidation, or cache. */
  cache: Fetched<T>['source'];
  local: LocalDataStatus;
}

export interface PlayerServiceDependencies {
  client: ChessComClient;
  localData: LocalDataService;
  defaultUsername: string;
}

/** Live profile and rating data straight from the Chess.com PubAPI (with the client's cache). */
export class PlayerService {
  constructor(private readonly deps: PlayerServiceDependencies) {}

  async getProfile(username?: string): Promise<PlayerLookup<ChessComProfile>> {
    const resolved = resolveUsername(username, this.deps.defaultUsername);
    return this.lookup(resolved, await this.deps.client.getPlayerProfile(resolved));
  }

  async getStats(username?: string): Promise<PlayerLookup<ChessComStats>> {
    const resolved = resolveUsername(username, this.deps.defaultUsername);
    return this.lookup(resolved, await this.deps.client.getPlayerStats(resolved));
  }

  private async lookup<T>(username: string, fetched: Fetched<T>): Promise<PlayerLookup<T>> {
    return {
      username,
      data: fetched.data,
      fetchedAt: fetched.fetchedAt,
      cache: fetched.source,
      local: await this.deps.localData.describe(username),
    };
  }
}
