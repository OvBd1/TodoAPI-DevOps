import { query } from '../db.js';
import Task from '../models/task.js';

const COLONNES = 'id, description, status, created_at, updated_at';

// Un id qui n'est pas un UUID ferait echouer la requete SQL : ce serait un 500 la ou
// l'utilisateur merite un 404.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function create(description, status) {
  const task = new Task(description, status);
  await query(
    `INSERT INTO tasks (${COLONNES}) VALUES ($1, $2, $3, $4, $5)`,
    [task.id, task.description, task.status, task.createdAt, task.updatedAt],
  );
  return task;
}

export async function list() {
  const { rows } = await query(`SELECT ${COLONNES} FROM tasks ORDER BY created_at`);
  return rows.map(Task.fromRow);
}

export async function get(id) {
  if (!UUID.test(id)) return null;
  const { rows } = await query(`SELECT ${COLONNES} FROM tasks WHERE id = $1`, [id]);
  return rows[0] ? Task.fromRow(rows[0]) : null;
}

export async function update(id, champs) {
  const task = await get(id);
  if (!task) return null;

  task.update(champs);
  await query(
    'UPDATE tasks SET description = $2, status = $3, updated_at = $4 WHERE id = $1',
    [task.id, task.description, task.status, task.updatedAt],
  );
  return task;
}

export async function remove(id) {
  if (!UUID.test(id)) return false;
  const { rowCount } = await query('DELETE FROM tasks WHERE id = $1', [id]);
  return rowCount > 0;
}
