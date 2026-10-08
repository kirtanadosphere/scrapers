import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { db } from './db.js'

async function main() {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
  const directory = path.resolve(process.cwd(), 'migrations')
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()
  for (const file of files) {
    const exists = await db.query('SELECT 1 FROM schema_migrations WHERE name=$1', [file])
    if (exists.rowCount) continue
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(await readFile(path.join(directory, file), 'utf8'))
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [file])
      await client.query('COMMIT')
      console.log(`Applied ${file}`)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
  await db.end()
}

main().catch((error) => { console.error(error); process.exit(1) })
