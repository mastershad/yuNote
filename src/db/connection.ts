import { open } from '@op-engineering/op-sqlite';

export interface OpSqliteDb {
  execute(sql: string, params?: unknown[]): Promise<{ rows?: Record<string, unknown>[] }>;
}

export function openDatabase(options: { name: string; location: string }): OpSqliteDb {
  return open(options);
}
