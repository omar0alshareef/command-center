import { sql001 } from './001_init';
import { sql002 } from './002_additions';
import { sql003 } from './003_started_at';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

// Ordered. Append only: never edit a migration that has shipped.
export const migrations: Migration[] = [
  { version: 1, name: 'init', sql: sql001 },
  { version: 2, name: 'additions', sql: sql002 },
  { version: 3, name: 'started_at', sql: sql003 },
];
