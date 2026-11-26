# Chess Intelligence MCP

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude answer
questions about a public Chess.com account using real data: profile, ratings, game history, opening
statistics, and performance summaries. Claude connects to it as a **remote MCP server over
Streamable HTTP**; Claude does the natural-language interpretation, this server only returns
structured data.

> **Status: Milestone 6 (remote deployment) implemented.** Tools, three MCP resources, and three
> prompt templates work end to end. The server is ready for a public HTTPS deployment that
> Claude.ai connects to without sign-in, restricted to Anthropic's outbound IP ranges and locked
> to one Chess.com username. Verification against a live Claude custom connector requires your
> deployment and Claude account; see [Connecting to Claude](#connecting-to-claude).

## What it does and does not do

**Does:** read public Chess.com PubAPI data for a configured username, store synchronized games in
PostgreSQL, and expose them to Claude through MCP tools, resources, and prompt templates.

**Does not:** use a chess engine, detect blunders or accuracy, coach, generate training plans,
log in to Chess.com, store Chess.com credentials, play games, or modify the Chess.com account in
any way. There is no frontend and no built-in LLM; the server never calls Claude.

## Architecture

```text
Claude ──MCP over HTTPS (Streamable HTTP)──▶ platform TLS proxy :443 ──▶ /mcp
                                              │
                    Express app ── /health (no auth, outside Host validation)
                       │
                       └─ /mcp: per-IP rate limit → access control (client IP allowlist,
                          else bearer token) → Host/Origin validation → createMcpHandler
                          (fresh McpServer per request, stateless)
                              ├─ tool handlers: Zod in/out schemas, username lock, error mapping
                              ├─ resources: coverage, last-sync, profile (chess:// URIs)
                              ├─ prompts: weekly-performance-review, opening-repertoire-review,
                              │           import-history
                              ├─ services: player (live), sync, games, analytics, local data
                              ├─ Chess.com PubAPI client → game normalizer (PGN via chess.js)
                              └─ repositories → PostgreSQL via Drizzle ORM
```

Tool handlers contain no SQL or analytics. They validate input, call a service, and map the
result to snake_case JSON. Services own the logic; analytics formulas are pure functions in
`src/domain/analytics.ts`. Resources are cheap read-only snapshots from the same services;
prompts are short user-message templates that point at existing tools.

| Path                                 | Purpose                                                              |
| ------------------------------------ | -------------------------------------------------------------------- |
| `src/index.ts`                       | Entrypoint: config, logger, DB pool, HTTP listen, shutdown           |
| `src/config/env.ts`                  | Zod-validated environment configuration                              |
| `src/server/transport.ts`            | Express app, `/health`, `/mcp`, request logging, error handling      |
| `src/server/access.ts`               | `/mcp` access control: client IP allowlist, then bearer token        |
| `src/server/auth.ts`                 | Static bearer-token verifier for the SDK's `requireBearerAuth`       |
| `src/utils/ip-allowlist.ts`          | CIDR parsing and IPv4/IPv6 matching (`node:net` `BlockList`)         |
| `src/server/create-server.ts`        | Per-request `McpServer` factory; tools, resources, and prompts       |
| `src/server/resources.ts`            | MCP resources: coverage, last-sync, optional profile snapshot        |
| `src/server/prompts.ts`              | MCP prompt templates for common sync → analyze workflows             |
| `src/server/tools/*.tools.ts`        | Tool definitions: descriptions, input/output schemas, annotations    |
| `src/server/tools/shared.ts`         | Shared schemas, date parsing, and the error-safe `runTool` wrapper   |
| `src/db/schema.ts`                   | Drizzle schema: `players`, `games`, `chesscom_archives`, `sync_runs` |
| `src/db/migrations/`                 | Generated SQL migrations (committed)                                 |
| `src/db/migrate.ts`                  | Migration runner                                                     |
| `src/clients/chesscom.client.ts`     | Chess.com PubAPI client: timeouts, retries, caching, errors          |
| `src/clients/chesscom.schemas.ts`    | Defensive Zod parsing and normalization of PubAPI responses          |
| `src/domain/game-normalizer.ts`      | Archive game → player-perspective `NormalizedGame`                   |
| `src/utils/pgn.ts`                   | PGN header parsing and SAN move validation (chess.js)                |
| `src/utils/errors.ts`                | `AppError` / `ChessComApiError` with client-safe messages            |
| `src/repositories/*.ts`              | Database access: players, games (idempotent upsert), archives, runs  |
| `src/domain/analytics.ts`            | Win rate, score %, averages, streaks, openings, rating trends        |
| `src/services/sync.service.ts`       | Bounded initial/incremental sync with overlap protection             |
| `src/services/player.service.ts`     | Live profile and stats lookups                                       |
| `src/services/game.service.ts`       | Filtered game listing and game details (local data only)             |
| `src/services/analytics.service.ts`  | Opening statistics and performance summaries                         |
| `src/services/local-data.service.ts` | Sync coverage and empty/stale/partial-data warnings                  |
| `src/services/create-services.ts`    | Wires the Chess.com client, repositories, and services               |
| `scripts/sync.ts`                    | Local CLI sync (`npm run sync`)                                      |
| `scripts/check-remote.ts`            | End-to-end check of a deployed server (`npm run check:remote`)       |
| `Dockerfile`                         | Production image: migrations, then server; non-root; health check    |

**SDK choice:** this project uses MCP TypeScript SDK **v2** (`@modelcontextprotocol/server`,
`@modelcontextprotocol/express`, `@modelcontextprotocol/node`), the current stable line. Its
`createMcpHandler` is stateless (no MCP sessions held in memory) and serves both the 2025-era
`initialize` handshake and the 2026-07-28 protocol from the same endpoint.

## Prerequisites

- Node.js 24 LTS or newer (`.nvmrc` pins 24; run `nvm use`).
- Docker with Docker Compose (for local PostgreSQL 18).
- A public Chess.com username. No Chess.com password or API key is needed.

## Local setup

```bash
nvm use
npm install
cp .env.example .env        # then set CHESSCOM_USERNAME and CHESSCOM_USER_AGENT
npm run db:up               # start PostgreSQL and wait for its health check
npm run db:migrate          # apply migrations
npm run dev                 # start the server with reload on http://127.0.0.1:3000
```

Check it:

```bash
curl http://127.0.0.1:3000/health
# {"status":"ok","service":"chess-intelligence-mcp","version":"0.1.0","checks":{"database":"ok"},...}
```

## Environment configuration

All configuration comes from environment variables, validated with Zod at startup. Invalid or
missing values stop the process with a list of actionable errors. `npm run dev`, `npm start`, and
`npm run db:migrate` load `.env` automatically if it exists; in production, set real environment
variables instead. `.env` is git-ignored and must never be committed.

| Variable                    | Default     | Notes                                                                                                   |
| --------------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                  | development | `development`, `test`, or `production`                                                                  |
| `LOG_LEVEL`                 | info        | Pino level (`silent` … `trace`)                                                                         |
| `PORT`                      | 3000        |                                                                                                         |
| `HOST`                      | 127.0.0.1   | Keep loopback locally. `0.0.0.0` in a container behind an HTTPS proxy                                   |
| `CHESSCOM_USERNAME`         | required    | Public Chess.com username; stored lowercase                                                             |
| `CHESSCOM_USER_AGENT`       | required    | Descriptive User-Agent with contact info, sent to Chess.com                                             |
| `DATABASE_URL`              | required    | `postgresql://…`                                                                                        |
| `TEST_DATABASE_URL`         | unset       | Used only by `npm test`; must name a `*_test` database (it is wiped)                                    |
| `MCP_ALLOWED_CLIENT_IPS`    | unset       | Comma-separated CIDR ranges admitted to `/mcp` without a token (Claude.ai: Anthropic's outbound ranges) |
| `MCP_AUTH_TOKEN`            | unset       | Bearer token for `/mcp` (at least 32 chars), accepted from any IP                                       |
| `MCP_ALLOW_UNAUTHENTICATED` | false       | Explicit opt-in for an open `/mcp` beyond loopback or in production. Not recommended                    |
| `MCP_ALLOWED_HOSTS`         | unset       | Comma-separated hostnames accepted in `Host`. **Required** if `HOST` is not loopback                    |
| `TRUST_PROXY`               | 0           | Reverse-proxy hops in front of the app; sets which `X-Forwarded-For` entry is the client IP             |
| `MCP_RATE_LIMIT_PER_MINUTE` | 120         | Requests per minute per client IP on `/mcp` (`0` disables). Over the limit: `429`                       |
| `MCP_ALLOW_ANY_USERNAME`    | false       | Let tools read any Chess.com username, not just `CHESSCOM_USERNAME`. Refused on an open public server   |
| `SYNC_COOLDOWN_SECONDS`     | 30          | Minimum gap between the end of one sync and the next for the same player (`0` disables)                 |
| `REQUEST_TIMEOUT_MS`        | 10000       | Chess.com request timeout                                                                               |
| `MAX_SYNC_MONTHS_PER_CALL`  | 12          | Upper bound on monthly archives processed by one sync call (default per call: 3)                        |
| `DEFAULT_GAME_LIMIT`        | 20          | Default `limit` for `get_recent_games` (maximum 100)                                                    |

**Local vs. production:** locally the server binds to `127.0.0.1`, `/mcp` may be open, and the
SDK rejects requests whose `Host`/`Origin` is not localhost (DNS-rebinding protection). When
`NODE_ENV=production` or `HOST` is not loopback, the server refuses to start unless `/mcp` is
restricted by `MCP_ALLOWED_CLIENT_IPS` and/or `MCP_AUTH_TOKEN` (or you set
`MCP_ALLOW_UNAUTHENTICATED=true`), and, when `HOST` is not loopback, unless `MCP_ALLOWED_HOSTS`
lists your public domain. See [Access control and HTTPS](#access-control-and-https).

## PostgreSQL

`docker-compose.yml` runs PostgreSQL 18 on `127.0.0.1:5432` only, with a named volume (`pgdata`)
and a `pg_isready` health check. On first start it also creates `chess_intelligence_test` for
integration tests.

```bash
npm run db:up      # start and wait until healthy
npm run db:down    # stop (data persists in the volume)
docker compose down -v   # stop and delete all local data
```

## Migrations

The schema lives in `src/db/schema.ts`; SQL migrations are generated into `src/db/migrations/`
and committed. The server itself never applies migrations; the Docker image's start command and
`npm run start:prod` run the migrator first, then start the server.

```bash
npm run db:generate          # after editing schema.ts: generate a new migration
npm run db:migrate           # apply pending migrations (development, via tsx)
npm run db:migrate:prod      # apply pending migrations from the compiled build
npm run db:studio            # optional: browse data with Drizzle Studio
```

Applying migrations is idempotent; already-applied migrations are skipped.

### Data model

| Table               | Purpose                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| `players`           | One row per Chess.com username (stored lowercase) plus profile fields            |
| `games`             | Standard-chess games, normalized from that player's perspective                  |
| `chesscom_archives` | Per player-month ETag/Last-Modified, last check, and game count (skip unchanged) |
| `sync_runs`         | Sync history: status, counters, and a summary of failed months                   |

Two deliberate deviations from the original specification:

- **Games are unique per `(player_id, chesscom_game_url)`**, not by URL alone. Tools accept an
  optional username, so a game between two synced players is stored once for each, each with its
  own result and color.
- **`chesscom_archives`** was added so syncs can send stored ETags and skip unchanged months.

## Running the server

```bash
npm run dev          # development with reload
npm run build        # compile to dist/
npm start            # run the compiled server
npm run start:prod   # apply migrations, then run the compiled server
```

At startup the server logs its access mode (`client-ip-allowlist`, `bearer-token`, both, or
`open`), the allowlisted ranges, the served username, the rate limit, and `TRUST_PROXY`. It never
logs the token.

The server stops gracefully on `SIGINT`/`SIGTERM`: it stops accepting connections, aborts in-flight
MCP exchanges, closes the database pool, and exits (forced after 10 seconds).

Endpoints:

- `POST|GET|DELETE /mcp` — MCP Streamable HTTP endpoint. JSON bodies are limited to 64 KB.
- `GET /health` — `200 {"status":"ok"}` when the database answers, `503 {"status":"degraded"}`
  otherwise. Never requires auth, is not rate limited, and never returns configuration or secrets.
  Use it as the platform health check.

## Testing with MCP Inspector

With the server running (`npm run dev`):

```bash
# Web UI: choose transport "Streamable HTTP" and URL http://127.0.0.1:3000/mcp
npx @modelcontextprotocol/inspector

# CLI
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --method initialize
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --method tools/list
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --method resources/list
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --method prompts/list

# Call a tool (arguments as name=value)
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --method tools/call \
  --tool-name sync_chesscom_games --tool-arg mode=initial --tool-arg months=2
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --method tools/call \
  --tool-name get_opening_statistics --tool-arg color=white --tool-arg time_class=blitz

# With MCP_AUTH_TOKEN set
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --method tools/list \
  --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

Inspector 2.x requires Node `^22.23.4 || ^24.22.1 || >=26.12.1`.

## Deploying to production

Claude.ai connects to remote MCP servers **from Anthropic's servers, not from your computer**, so
the server must be reachable from the internet:

- a public HTTPS URL on **port 443** with a valid certificate (custom ports are not supported);
- a public DNS **A record**: Anthropic connects over IPv4 only;
- a PostgreSQL database reachable from the app;
- one app instance (rate-limit counters are kept in memory per instance).

TLS is terminated by the hosting platform or a reverse proxy (for example Caddy or nginx); the
app speaks plain HTTP on `PORT` inside that network. Never expose `PORT` directly to the internet.

### Docker image

```bash
docker build -t chess-intelligence-mcp .
docker run --rm -p 3000:3000 --env-file production.env chess-intelligence-mcp
```

The image (Node 24 Alpine, production dependencies only, runs as the non-root `node` user)
defaults to `NODE_ENV=production`, `HOST=0.0.0.0`, and `PORT=3000`. On start it applies pending
migrations, then starts the server; a failed migration stops the container. Its `HEALTHCHECK`
calls `/health`. Any platform that builds a Dockerfile and provides HTTPS on 443 works; without
Docker, run `npm ci && npm run build && npm run start:prod`.

Production environment (set these in the platform's secret manager, never in the image):

```bash
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
CHESSCOM_USERNAME=your_chesscom_username
CHESSCOM_USER_AGENT=ChessIntelligenceMCP/1.0 (contact: you@example.com)
DATABASE_URL=postgresql://user:password@db-host:5432/chess_intelligence
MCP_ALLOWED_HOSTS=chess.example.com
# Anthropic's outbound IPv4 ranges: https://platform.claude.com/docs/en/api/ip-addresses
MCP_ALLOWED_CLIENT_IPS=160.79.104.0/21,153.61.208.0/20
TRUST_PROXY=1
# Optional: also admit Claude Code or MCP Inspector from any IP with a token.
MCP_AUTH_TOKEN=
```

**`TRUST_PROXY`** is the number of reverse proxies in front of the app that append to
`X-Forwarded-For`. One platform load balancer or one Caddy/nginx: `1`. Add one for each extra
layer, such as a CDN in front of the platform. If it is too low, the server sees the proxy's IP,
answers Claude with `403`, and all clients share one rate-limit bucket. If it is too high, a
client can forge `X-Forwarded-For` to look like Anthropic. The `403` log line ("Rejected /mcp
request from a client IP outside the allowlist") shows the IP the server resolved; Claude's
requests should resolve to `160.79.*` or `153.61.*`.

Check a deployment from your machine (it only reaches `/mcp` with a token, because your IP is not
allowlisted):

```bash
npm run check:remote -- https://chess.example.com
REMOTE_MCP_TOKEN=<token> npm run check:remote -- https://chess.example.com   # if MCP_AUTH_TOKEN is set
```

To try the production image locally (plain HTTP on `localhost:3001`, token-protected):

```bash
export MCP_AUTH_TOKEN=$(openssl rand -hex 32)
docker compose --profile app up --build -d
REMOTE_MCP_TOKEN=$MCP_AUTH_TOKEN npm run check:remote -- http://localhost:3001
docker compose stop app
```

## Connecting to Claude

These steps add the server to **Claude.ai** (web and desktop) as a custom connector without sign-in.
Labels can differ slightly between Claude versions.

1. Deploy as described above and confirm `https://<your-domain>/health` returns
   `{"status":"ok", …}`.
2. Add the connector:
   - **Individual plans (Free, Pro, Max):** in Claude, open **Customize → Connectors**, then
     **Add custom connector**.
   - **Team and Enterprise:** an Owner opens **Organization settings → Connectors → Add →
     Custom → Web**. Members then connect it from **Customize → Connectors**.
3. Name it `Chess Intelligence` and enter the URL `https://<your-domain>/mcp`.
4. For authentication, choose **No sign in** (leave any OAuth client ID and secret fields empty),
   then **Add**.
5. In a chat, enable the connector from the tools menu and ask: "Get my Chess.com profile."
6. Then: "Sync my last 3 months of Chess.com games", followed by questions such as "What are my
   best openings as White in blitz?"

Custom connector availability, limits (for example, how many custom connectors a Free account can
add), and beta status depend on your Claude plan and are controlled by Anthropic; they can change.
See [Get started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
This project does not require a Claude API key or a paid API plan.

**Claude Code (optional):** with `MCP_AUTH_TOKEN` set on the server,

```bash
claude mcp add --transport http chess-intelligence https://<your-domain>/mcp \
  --header "Authorization: Bearer <token>"
```

**Temporary tunnel (development only):** a tunnel such as `cloudflared tunnel --url
http://127.0.0.1:3000` gives a temporary public HTTPS URL without deploying. Keep
`HOST=127.0.0.1` and set `MCP_ALLOWED_HOSTS=<tunnel hostname>`,
`MCP_ALLOWED_CLIENT_IPS=160.79.104.0/21,153.61.208.0/20`, and `TRUST_PROXY=1`, then stop the
tunnel when done. The tunnel adds its own proxy hop, so confirm with the log line above that
Claude's requests resolve to an Anthropic IP. This setup has not been verified end to end.

## Access control and HTTPS

**Chosen mechanism: no sign-in, restricted to Anthropic's IPs, one username.** The original
specification asked for authentication before public deployment without inventing a custom
OAuth flow. Claude.ai custom connectors authenticate with OAuth or not at all; fixed request
headers (a static bearer token) are a limited beta for organization Owners. A real OAuth setup
would need an external identity provider, so this deployment deliberately runs **without
sign-in** and relies on these layers instead:

1. **Client IP allowlist.** `/mcp` admits only `MCP_ALLOWED_CLIENT_IPS`; everyone else gets
   `403` before any MCP handling. With Anthropic's ranges this means only Claude's connector
   infrastructure reaches the tools.
2. **Optional bearer token.** If `MCP_AUTH_TOKEN` is set, clients outside the allowlist may use
   `Authorization: Bearer <token>` (constant-time comparison via the SDK's `requireBearerAuth`);
   missing or wrong tokens get `401` with a `WWW-Authenticate: Bearer` challenge. Claude.ai never
   sees that challenge, because its IPs are admitted first, so it never starts an OAuth flow.
3. **Username lock.** Tools serve only `CHESSCOM_USERNAME`; any other username returns
   `username_not_allowed`. `MCP_ALLOW_ANY_USERNAME=true` lifts this, but is refused on an open
   public server.
4. **Rate limit.** `MCP_RATE_LIMIT_PER_MINUTE` per client IP on `/mcp` (rejected requests count
   too), answered with `429` and standard `RateLimit` headers. `/health` is not limited.
5. **Bounded syncs.** A per-player lock, `MAX_SYNC_MONTHS_PER_CALL`, and a
   `SYNC_COOLDOWN_SECONDS` cooldown (`sync_cooldown` error) limit how much Chess.com traffic
   anyone can trigger.

**Residual risk:** every Claude.ai user's connector traffic comes from the same Anthropic
ranges, so anyone with a Claude account who learns your `/mcp` URL can add it as a connector.
They could then read your **public** Chess.com data (which Chess.com publishes anyway), read your
synced games, and trigger bounded syncs. They cannot reach other usernames, modify anything on
Chess.com, or run anything except the registered tools, resources, and prompts. Keep the URL
private. If that is not acceptable, put OAuth with an external identity provider in front (this
server would act only as a resource server) or use static request headers if your organization
has that beta.

Identity-aware proxies that need an interactive login (such as SSO in front of the app) cannot
protect a Claude.ai connector, because Anthropic's servers cannot complete that login. A
platform firewall or ingress rule that allows only Anthropic's ranges to reach the app is an
equivalent alternative to `MCP_ALLOWED_CLIENT_IPS`.

Request order on `/mcp`: rate limit → IP allowlist, else bearer token → `Host`/`Origin`
validation → MCP handler.

| Response | Body                       | Meaning                                                       |
| -------- | -------------------------- | ------------------------------------------------------------- |
| `403`    | `{"error":"forbidden"}`    | Client IP not allowlisted and no token configured             |
| `401`    | OAuth-style error          | Client IP not allowlisted; bearer token missing or wrong      |
| `403`    | JSON-RPC error             | `Host` not in `MCP_ALLOWED_HOSTS` (or `Origin` not allowed)   |
| `429`    | `{"error":"rate_limited"}` | Over `MCP_RATE_LIMIT_PER_MINUTE`; see the `RateLimit` headers |

Tokens and authorization headers are never logged. Request logs contain only request ID, method,
path, status, and duration; rejected `/mcp` requests also log the resolved client IP.
`x-request-id` is echoed or generated per request.

## Privacy

Data returned by this server is sent to Claude as part of your conversation with Claude. The
server only reads public Chess.com data and never stores Chess.com credentials. Tool calls are
logged with the tool name, duration, and error code only: no arguments, results, or PGNs.

## Chess.com API client

`ChessComClient` reads four documented PubAPI endpoints for a validated username:

| Method                                                  | Endpoint                                       |
| ------------------------------------------------------- | ---------------------------------------------- |
| `getPlayerProfile(username)`                            | `GET /pub/player/{username}`                   |
| `getPlayerStats(username)`                              | `GET /pub/player/{username}/stats`             |
| `getArchiveList(username)`                              | `GET /pub/player/{username}/games/archives`    |
| `getArchiveGames(username, {year, month}, validators?)` | `GET /pub/player/{username}/games/{YYYY}/{MM}` |

Behavior, matching the [PubAPI documentation](https://www.chess.com/news/view/published-data-api):

- **Only known URLs.** Requests are built from a validated, lowercased username and a validated
  year/month; archive URLs returned by Chess.com are parsed, never fetched as-is. Redirects are
  followed only within `https://api.chess.com/pub/`.
- **Serial requests.** Chess.com does not rate-limit serial access but may return `429` for
  parallel requests, so the client runs one request at a time process-wide.
- **Timeouts and retries.** Each attempt is bounded by `REQUEST_TIMEOUT_MS` (headers and body).
  Network errors, timeouts, `429`, and `5xx` are retried up to 2 times with exponential backoff,
  or after `Retry-After` when present (up to 30 s; longer waits surface as `rate_limited`).
  `404`, `410`, other `4xx`, and malformed responses are not retried.
- **Caching.** Profile, stats, and archive-list responses are kept in a small in-memory cache:
  served directly within `Cache-Control: max-age`, then revalidated with `If-None-Match` /
  `If-Modified-Since` (a `304` reuses the cached copy). Monthly archives are not cached in memory;
  `getArchiveGames` returns the response's ETag/Last-Modified, which are persisted in
  `chesscom_archives` so unchanged months come back `not_modified`. In practice Chess.com honors
  `If-None-Match` but answers `200` to its own non-standard `Last-Modified` dates, so ETags do the
  work.
- **Defensive parsing.** Responses are capped at 25 MiB and validated with Zod. Missing or
  malformed optional fields become `null`; a malformed game is skipped and reported in
  `skipped`, without failing the rest of the month. Stats categories (`chess_rapid`,
  `chess960_daily`, …) appear only when Chess.com returns them.
- **Typed errors.** Failures throw `ChessComApiError` with `kind` `invalid_input`, `not_found`,
  `gone`, `rate_limited`, `timeout`, `network`, `upstream_error`, or `invalid_response`, and a
  message that is safe to show to Claude (never the upstream body).

Live check against the real API (development only; tests use mocked responses):

```bash
npm run smoke:chesscom              # uses CHESSCOM_USERNAME
npm run smoke:chesscom -- erik      # any public username
```

## Game normalization

Each archived game is normalized from the synced player's perspective before storage
(`src/domain/game-normalizer.ts`):

- **Color:** usernames are compared case-insensitively. Games the player is not in are rejected.
- **Result:** Chess.com result codes map to `win` (`win`), `loss` (`checkmated`, `resigned`,
  `timeout`, `lose`, `abandoned`, …), or `draw` (`agreed`, `repetition`, `stalemate`,
  `insufficient`, `50move`, `timevsinsufficient`). The player's code is used first, then the
  opponent's (inverted), then the PGN `Result` tag. Unknown codes are never treated as draws, and
  if the sources disagree the game is rejected rather than guessed.
- **Ratings:** from the archive JSON, falling back to PGN `WhiteElo`/`BlackElo`; otherwise `null`.
- **ECO and opening:** ECO from the PGN `ECO` tag (`A00`–`E99`). Chess.com sends no opening-name
  tag, so `opening_name` is derived from its opening-page URL with the trailing move sequence
  removed (for example `…/openings/Caro-Kann-Defense-Advance-Variation-3...Bf5` becomes
  `Caro Kann Defense Advance Variation`). Otherwise `null`.
- **Moves:** the PGN is validated with chess.js; `san_moves` holds the SAN list, or `null` with a
  warning if the movetext is malformed. The game is still stored, and the original PGN is always
  kept. PGN comments are never interpreted.
- **`played_at`** is the game's end time (Chess.com `end_time`), which is also how monthly
  archives are grouped.
- **Not stored, with a reason:** variants (chess960, crazyhouse, …, since Version 1 covers standard
  chess only), games without a PGN, and games with unknown or contradictory results.

`GameRepository.upsertMany` is idempotent: re-syncing the same games inserts and updates nothing
(rows are rewritten only when content actually changed), and each batch runs in one transaction.

## Syncing Chess.com games

Sync is user-triggered only; there is no background scheduler. Claude triggers it through the
`sync_chesscom_games` tool (for example, "sync my last 3 months of games"). For development there
is also a local CLI:

```bash
npm run sync                                   # incremental, 3 months, CHESSCOM_USERNAME
npm run sync -- --mode initial --months 6      # import 6 more months of history
npm run sync -- --username erik --months 1     # any public username
```

The CLI prints the sync report as JSON on stdout (logs go to stderr).

**Modes.** Each call processes at most `months` monthly archives (default 3, maximum
`MAX_SYNC_MONTHS_PER_CALL`), one at a time, newest first:

- **`incremental`** (default) re-checks the newest `months` archives. Months already downloaded are
  requested with their stored ETag, so an unchanged month costs one `304 Not Modified` and no
  database writes. Use it to pick up new games.
- **`initial`** imports the newest `months` archives that have never been downloaded. Calling it
  again continues further back; the report's `archivesRemaining` says how much history is left.
  There is deliberately no "import everything" option.

**Storage rules.** Games are upserted by `(player, game URL)`, so re-syncing never duplicates and
rewrites a row only when its content changed. Games missing from a later archive response are never
deleted. Each month's games and its archive record are written in one transaction, so a failure
leaves that month cleanly un-synced.

**Overlapping syncs.** A sync holds a PostgreSQL session advisory lock for its player for its whole
duration. A second sync for the same player (from this process or another instance) is rejected
immediately with `sync_in_progress`; syncs for different players can run concurrently. If a process
dies mid-sync, PostgreSQL drops the lock with the connection, and the next sync for that player
marks the orphaned `running` row as failed ("Interrupted…").

**Failures.** Per-month failures do not abort the sync:

| Situation                                          | Behavior                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| One month fails (404, 5xx after retries, bad JSON) | Reported in `failures`; remaining months are still processed         |
| Rate limited, timeout, or network failure          | Stops early; skipped months counted in `archivesNotAttempted`        |
| Profile refresh fails (other than 404)             | Warning only; games still sync                                       |
| Unknown player, or archive list unavailable        | Whole sync fails (`status = failed` in `sync_runs`), error returned  |
| Unexpected internal error (for example database)   | Whole sync fails with a generic message; details only in server logs |

A sync with month failures returns `status: "partial"` and is stored in `sync_runs` as `success`
with the failed months summarized in `error_message`. A failed month is simply retried on the next
call.

**Report fields** (snake_case in the MCP tool, camelCase in the CLI): `status` (`success` |
`partial`), `mode`, `months_requested`, `archives_available`, `archives_checked`,
`archives_downloaded`, `archives_not_modified`, `archives_failed`, `archives_not_attempted`,
`games_fetched`, `games_inserted`, `games_updated`, `games_unchanged`, `games_skipped`, `coverage`
(`{ from, to }` as `YYYY-MM`), `archives_remaining`, `failures`, `warnings` (capped at 20), plus
the sync run ID and timestamps.

## MCP resources

Clients can discover local coverage and sync staleness without inventing a tool sequence.
`resources/list` returns concrete URIs for the configured `CHESSCOM_USERNAME`. URI templates use
`chess://player/{username}/…`; the username lock still applies on read.

| URI                                            | Source                        | Contents                                                                  |
| ---------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `chess://player/{username}/coverage`           | Local database                | `data_coverage` (games stored, synced months, last sync) plus warnings    |
| `chess://player/{username}/last-sync`          | Local database (`sync_runs`)  | Last run status/counters and `last_successful_sync_at`                    |
| `chess://player/{username}/profile` (optional) | Chess.com PubAPI (live/cache) | Profile snapshot plus `local_data`; prefer `get_player_profile` for tools |

Bodies are `application/json`. Prefer tools when you need structured tool results and annotations;
use resources when the client wants a discoverable snapshot (Inspector, connectors that surface
resources).

## MCP prompts

Registered prompt templates encode common workflows as short user messages that name the tools to
call. They do not run tools themselves.

| Prompt                      | Args                                    | Intended tool sequence                                                                             |
| --------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `weekly-performance-review` | optional `time_class`                   | `sync_chesscom_games` (if needed) → `get_performance_summary` (`7d`) → optional `get_recent_games` |
| `opening-repertoire-review` | `color`, optional `time_class`          | sync if needed → `get_opening_statistics` → optional `get_game_details`                            |
| `import-history`            | `months` (1–`MAX_SYNC_MONTHS_PER_CALL`) | `sync_chesscom_games` with `mode: "initial"`; repeat while `archives_remaining` > 0                |

List them with Inspector `prompts/list` (or any MCP client that supports prompts).

## MCP tools

The tool names are stable. Every tool takes an optional `username` (default:
`CHESSCOM_USERNAME`) and validates all input with Zod.

| Tool                      | Data source          | Purpose                                                                                 |
| ------------------------- | -------------------- | --------------------------------------------------------------------------------------- |
| `get_player_profile`      | Chess.com (live)     | Name, title, country, profile URL, join date, last online                               |
| `get_player_stats`        | Chess.com (live)     | Current and best rating plus all-time record per category; FIDE, tactics                |
| `sync_chesscom_games`     | Chess.com → database | Import monthly archives (`mode`, `months` 1–`MAX_SYNC_MONTHS_PER_CALL`)                 |
| `get_recent_games`        | Local database       | Newest-first games; filter by `time_class`, `result`, `color`, dates; page              |
| `get_game_details`        | Local database       | Metadata, PGN, and SAN moves for one stored game by `game_url`                          |
| `get_opening_statistics`  | Local database       | Per-opening results; `color` (white/black/both), `time_class`, dates, `min_games`       |
| `get_opponent_statistics` | Local database       | Per-opponent / head-to-head; optional `opponent`, color, time class, dates, `min_games` |
| `get_performance_summary` | Local database       | `period` 7d/30d/90d/all: results, colors, ratings, streaks, top openings                |

**Response format.** Each tool returns a one-line text summary, the same data as JSON text (for
clients that ignore structured output), and `structuredContent` matching a published
`outputSchema`. Field names are snake_case. Every response includes `username`, `source`
(`chesscom_pubapi` or `local_database`), `generated_at`, and `warnings`, all timestamps are ISO
8601, and local-data tools include `data_coverage` (games stored, synced months, last sync).
Warnings flag an empty database, data older than 24 hours, a failed or partial last sync, date
ranges that start before the earliest synced month, and truncated analytics.

**Errors** come back as tool results with `isError: true` and a message such as
`Error (game_not_found): …` or `Error (chesscom_rate_limited): … try again in about 30 seconds`.
Unexpected internal errors return a generic message; details go only to server logs.

**Bounds.** `get_recent_games`: `limit` 1–100 (default `DEFAULT_GAME_LIMIT`), `offset` ≤ 10,000,
and no PGNs (use `get_game_details`). `get_opening_statistics` / `get_opponent_statistics`:
`limit` 1–100 (default 20), `min_games` default 3 (1 when `opponent` is set on opponent stats).
Analytics consider at most the 50,000 most recent matching games and warn if more exist. Request
bodies are capped at 64 KB.

**`get_game_details` safety.** The URL is only a lookup key into the local database and is never
fetched. It accepts `https://www.chess.com/game/<type>/<id>`, with or without `www`, a trailing
slash, or a `?move=` query. The PGN is returned as untrusted data, with a note that comments
inside it are not instructions.

### Analytics definitions

All statistics are computed from the requested player's perspective over the filtered games.

| Statistic         | Definition                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| Win rate          | `wins / games * 100`, one decimal. Draws and losses are not wins                                   |
| Score percentage  | `(wins + 0.5 * draws) / games * 100`, one decimal                                                  |
| Average rating    | Arithmetic mean of non-null ratings, rounded; `games_with_rating` is the denominator               |
| Color performance | The same metrics computed separately for games as White and as Black                               |
| Streak            | Consecutive wins (or losses) in chronological order; a draw ends both; ties report the most recent |
| Opening group     | ECO code plus opening name; distinct ECO codes are never merged; `low_sample` below 10 games       |
| Opponent group    | Opponent username, case-insensitive; `low_sample` below 10 games; includes color split             |
| Rating trend      | Per time class: player's rating in the last minus the first rated synced game                      |

Every percentage sits next to its game count, and statistics that can't be computed (for example,
no games) are `null`, not `0`. Rating trends sample synchronized archive games and are not an
official rating history; for current official ratings use `get_player_stats`. When no
`time_class` is given, `average_player_rating` mixes time classes, and a warning says so.

### Example prompts

- "What's my current blitz rating and my best ever?" → `get_player_stats`
- "Sync my games from the last 3 months." → `sync_chesscom_games`
- "Import another 6 months of older history." → `sync_chesscom_games` with `mode: "initial"`
- "Show my last 10 rapid losses." → `get_recent_games`
- "Walk me through the moves of this game: https://www.chess.com/game/live/123456789" →
  `get_game_details`
- "Which openings score best for me as Black in blitz this year?" → `get_opening_statistics`
- "Who have I played most, and how do I do against Hikaru?" → `get_opponent_statistics`
- "How did I do over the last 30 days, and what was my longest losing streak?" →
  `get_performance_summary`

## Development scripts

| Script                   | Purpose                                        |
| ------------------------ | ---------------------------------------------- |
| `npm run dev`            | Start with reload (`tsx watch`)                |
| `npm run build`          | Compile TypeScript to `dist/`                  |
| `npm start`              | Run the compiled server                        |
| `npm run start:prod`     | Apply migrations, then run the compiled server |
| `npm run check:remote`   | Check a deployed server (`-- <base-url>`)      |
| `npm run typecheck`      | TypeScript strict checks (src, tests, configs) |
| `npm run lint`           | ESLint (type-aware)                            |
| `npm run format`         | Prettier write (`format:check` to verify only) |
| `npm test`               | Vitest (unit + integration)                    |
| `npm run db:up/db:down`  | Start/stop local PostgreSQL                    |
| `npm run db:generate`    | Generate a migration from the schema           |
| `npm run db:migrate`     | Apply migrations                               |
| `npm run db:studio`      | Drizzle Studio                                 |
| `npm run smoke:chesscom` | Live Chess.com connectivity check              |
| `npm run sync`           | Local CLI sync (see "Syncing Chess.com games") |

Tests never call the live Chess.com API. Database integration tests run only when
`TEST_DATABASE_URL` is set (it is in `.env.example`) and refuse to run against a database whose
name does not end in `_test`.

## Known limitations

- Analytics only see synchronized games. Until older months are imported with
  `mode: "initial"`, "all time" means "all synchronized months" (see `data_coverage`).
- A long `sync_chesscom_games` call (many busy months) can take tens of seconds; keep `months`
  small if your client has a short tool timeout.
- Chess.com occasionally fails on a single month. For example, a current month can return `404`
  with "An internal error has occurred" even though the archive list advertises it. Sync reports
  it as a failed month and retries it next time. In `initial` mode, a month that keeps failing
  still uses one of the call's `months` slots each time.
- Only standard chess games are stored; chess960 and other variants are skipped.
- Opening names are derived from Chess.com opening-page URLs, so punctuation such as the hyphen
  in "Caro-Kann" or the apostrophe in "King's" is not preserved.
- Chess.com data refreshes on their side at most every 12–24 hours for some endpoints, and their
  docs note a small share of data may lag for players on the legacy site.
- The Claude.ai deployment has no per-user sign-in. Access relies on Anthropic's published IP
  ranges, so any Claude user who knows the URL can use the connector (see
  [Access control and HTTPS](#access-control-and-https)). If Anthropic changes its outbound
  ranges, update `MCP_ALLOWED_CLIENT_IPS`.
- Rate-limit counters live in memory: they reset on restart and are not shared between
  instances. All Claude.ai traffic shares Anthropic's IPs, and therefore one rate-limit bucket.
- Claude's tool calls have their own timeouts; keep `months` small for syncs started from Claude.
- `npm audit` reports a moderate advisory in an old `esbuild` pulled in transitively by
  `drizzle-kit` (dev-only; it concerns esbuild's dev server, which this project does not run).

## Troubleshooting

- **`Invalid environment configuration`** at startup: the message lists each bad variable;
  compare with `.env.example`.
- **`/health` returns 503**: PostgreSQL is unreachable. Run `npm run db:up` and check
  `DATABASE_URL`.
- **`403 {"error":"forbidden"}` from `/mcp`**: the client IP is outside `MCP_ALLOWED_CLIENT_IPS`.
  Expected from your own machine; for Claude, check `TRUST_PROXY` against the logged IP.
- **`403` with a JSON-RPC error from `/mcp`**: the `Host` or `Origin` header is not allowed.
  Locally, use `127.0.0.1`/`localhost`; in production, add your domain to `MCP_ALLOWED_HOSTS`.
- **`401` from `/mcp`**: send `Authorization: Bearer <MCP_AUTH_TOKEN>`.
- **`429` from `/mcp`**: over `MCP_RATE_LIMIT_PER_MINUTE`; wait for the window in the
  `RateLimit` header.
- **Claude says it couldn't reach or connect to the server**: confirm `https://<domain>/health`
  works from the internet on port 443 with a valid certificate and an IPv4 A record, the URL
  ends in `/mcp`, and the server log shows the request. A `403` there means `TRUST_PROXY` or
  `MCP_ALLOWED_CLIENT_IPS` is wrong; nothing logged means DNS, TLS, or the platform's firewall.
- **`username_not_allowed`**: the tools serve only `CHESSCOM_USERNAME`; omit `username`.
- **`sync_cooldown`**: a sync just finished; wait the stated number of seconds.
- **Docker Hub `429 Too Many Requests`** when pulling Postgres or Node: wait, run `docker login`,
  or pull the same official image from the AWS mirror and tag it:
  `docker pull public.ecr.aws/docker/library/postgres:18-alpine && docker tag public.ecr.aws/docker/library/postgres:18-alpine postgres:18-alpine`
  (likewise `node:24-alpine` for the app image).
- **`npm ci` fails in `docker build` with "Missing: … from lock file"**: the lockfile was written
  by an older npm. Run `nvm install 24 && nvm use 24`, then `npm install`, so the lockfile
  matches the npm in `node:24-alpine`.
- **Migration tests skipped**: set `TEST_DATABASE_URL`. If the test database is missing (volume
  created before the init script existed), run
  `docker exec chess-intelligence-postgres createdb -U postgres chess_intelligence_test`.
