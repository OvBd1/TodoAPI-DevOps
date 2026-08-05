import Task from '../models/task.js';
import * as taches from '../repositories/task.js';

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isValidStatus(value) {
  return typeof value === 'string' && Task.STATUSES.includes(value.trim());
}

const INVALID_STATUS = `status doit valoir l'une des valeurs suivantes : ${Task.STATUSES.join(', ')}`;
const TROP_LONGUE = `description ne doit pas depasser ${Task.DESCRIPTION_MAX} caracteres`;

function erreurDescription(description, requise) {
  if (!isNonEmptyString(description)) {
    return requise
      ? 'description est requis et doit être une chaîne non vide'
      : 'description doit être une chaîne non vide';
  }
  if (description.trim().length > Task.DESCRIPTION_MAX) return TROP_LONGUE;
  return null;
}

export async function createTask(req, res, next) {
  const { description, status } = req.body ?? {};

  const probleme = erreurDescription(description, true);
  if (probleme) return next(httpError(400, probleme));
  if (status !== undefined && !isValidStatus(status)) {
    return next(httpError(400, INVALID_STATUS));
  }

  const task = await taches.create(description.trim(), status?.trim());
  res.status(201).json(task);
}

export async function listTasks(req, res) {
  res.json(await taches.list());
}

export async function getTask(req, res, next) {
  const task = await taches.get(req.params.id);
  if (!task) return next(httpError(404, `Tâche ${req.params.id} introuvable`));
  res.json(task);
}

export async function updateTask(req, res, next) {
  const { description, status } = req.body ?? {};

  if (description === undefined && status === undefined) {
    return next(httpError(400, 'Au moins un champ (description, status) doit être fourni'));
  }
  if (description !== undefined) {
    const probleme = erreurDescription(description, false);
    if (probleme) return next(httpError(400, probleme));
  }
  if (status !== undefined && !isValidStatus(status)) {
    return next(httpError(400, INVALID_STATUS));
  }

  const task = await taches.update(req.params.id, {
    description: description?.trim(),
    status: status?.trim(),
  });
  if (!task) return next(httpError(404, `Tâche ${req.params.id} introuvable`));

  res.json(task);
}

export async function deleteTask(req, res, next) {
  if (!(await taches.remove(req.params.id))) {
    return next(httpError(404, `Tâche ${req.params.id} introuvable`));
  }
  res.status(204).end();
}
