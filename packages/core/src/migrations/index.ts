import { sql001 } from './001_init';
import { sql002 } from './002_additions';
import { sql003 } from './003_started_at';
import { sql004 } from './004_lessons_prevention';
import { sql005 } from './005_planning';
import { sql006 } from './006_executor';
import { sql007 } from './007_agent_model';
import { sql008 } from './008_orchestrator';
import { sql009 } from './009_lessons_scope';

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
  { version: 4, name: 'lessons_prevention', sql: sql004 },
  { version: 5, name: 'planning', sql: sql005 },
  { version: 6, name: 'executor', sql: sql006 },
  { version: 7, name: 'agent_model', sql: sql007 },
  { version: 8, name: 'orchestrator', sql: sql008 },
  { version: 9, name: 'lessons_scope', sql: sql009 },
];
