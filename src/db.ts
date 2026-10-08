import pg from 'pg'
import { config } from './config.js'

export const db = new pg.Pool({ connectionString: config.DATABASE_URL, max: 15 })

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<pg.QueryResult<T>> {
  return db.query<T>(text, values)
}

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/(bearer|token|key|secret|password)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]').slice(0, 2000)
}
