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

// Sans cet ecouteur, l'arret de PostgreSQL emet un evenement 'error' sur un client inactif,
// et un evenement 'error' sans ecouteur fait tomber le processus Node.
pool.on('error', (err) => {
  console.error('erreur sur un client inactif du pool :', err.message);
});

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');

export function query(texte, valeurs) {
  return pool.query(texte, valeurs);
}

export async function migrate() {
  const schema = await readFile(join(racine, 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
}

// Au demarrage, la base peut n'etre pas encore la. On reessaie, puis on demarre quand meme :
// une API qui repond 500 sur /api/tasks est diagnosticable, une API en boucle de crash ne l'est pas.
export async function migrateAvecPatience(essais = 10, delaiMs = 3000) {
  for (let i = 1; i <= essais; i += 1) {
    try {
      await migrate();
      return true;
    } catch (err) {
      console.error(`migration : tentative ${i}/${essais} echouee (${err.message})`);
      if (i < essais) await new Promise((r) => setTimeout(r, delaiMs));
    }
  }
  console.error("migration impossible : l'API demarre sans schema, /api/tasks repondra 500");
  return false;
}

export function close() {
  return pool.end();
}
