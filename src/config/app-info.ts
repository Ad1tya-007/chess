import { readFileSync } from 'node:fs';

import * as z from 'zod/v4';

// Resolves to the repository root from both src/config and dist/config.
const packageJsonUrl = new URL('../../package.json', import.meta.url);

const packageJson = z
  .object({ name: z.string(), version: z.string() })
  .parse(JSON.parse(readFileSync(packageJsonUrl, 'utf8')));

export const APP_NAME = packageJson.name;
export const APP_VERSION = packageJson.version;
