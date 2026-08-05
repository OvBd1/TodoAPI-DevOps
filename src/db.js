import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'todo',
  user: process.env.DB_USER || 'todo',
  password: process.env.DB_PASSWORD || 'todo',
});

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');

export function query(texte, valeurs) {
  return pool.query(texte, valeurs);
}

export async function migrate() {
  const schema = await readFile(join(racine, 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
}

export function close() {
  return pool.end();
}
