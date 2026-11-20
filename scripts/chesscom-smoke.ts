/**
 * Live connectivity smoke test against the real Chess.com PubAPI (development only; tests use
 * mocks). Usage: npm run smoke:chesscom [-- <username>]
 */
import { ChessComClient } from '../src/clients/chesscom.client.js';
import { ConfigError, loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/utils/logger.js';

const write = (line = '') => process.stdout.write(`${line}\n`);

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

const username = process.argv[2] ?? config.CHESSCOM_USERNAME;
const client = new ChessComClient({
  userAgent: config.CHESSCOM_USER_AGENT,
  timeoutMs: config.REQUEST_TIMEOUT_MS,
  logger: createLogger({ LOG_LEVEL: 'warn', NODE_ENV: config.NODE_ENV }),
});

const profile = await client.getPlayerProfile(username);
write(
  `Profile: ${profile.data.username} (title: ${profile.data.title ?? '-'}, country: ${profile.data.countryCode ?? '-'})`,
);
write(`  joined: ${profile.data.joinedAt?.toISOString() ?? 'unknown'}  source: ${profile.source}`);

const stats = await client.getPlayerStats(username);
for (const rating of stats.data.ratings) {
  const record = rating.record
    ? `${rating.record.wins}W/${rating.record.losses}L/${rating.record.draws}D`
    : 'no record';
  write(
    `  ${rating.category.padEnd(16)} current ${rating.current?.rating ?? '-'}  best ${rating.best?.rating ?? '-'}  ${record}`,
  );
}
if (stats.data.warnings.length > 0) write(`  warnings: ${stats.data.warnings.join(' | ')}`);

const archives = await client.getArchiveList(username);
const list = archives.data.archives;
write(`Archives: ${list.length} months (ignored entries: ${archives.data.ignoredEntries})`);

const latest = list.at(-1);
if (latest) {
  const label = `${latest.year}-${String(latest.month).padStart(2, '0')}`;
  const first = await client.getArchiveGames(username, latest);
  if (first.status === 'modified') {
    write(
      `Latest archive ${label}: ${first.data.games.length} games, ${first.data.skipped.length} skipped`,
    );
    write(`  etag: ${first.validators.etag ?? 'none'}`);
    const second = await client.getArchiveGames(username, latest, first.validators);
    write(`  conditional re-request: ${second.status}`);
  }
}
