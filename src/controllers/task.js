import Task from '../models/task.js';

const tasks = new Map();

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

export function createTask(req, res, next) {
  const { description, status } = req.body ?? {};

  if (!isNonEmptyString(description)) {
    return next(httpError(400, 'description est requis et doit être une chaîne non vide'));
  }
  if (status !== undefined && !isValidStatus(status)) {
    return next(httpError(400, INVALID_STATUS));
  }

  const task = new Task(description.trim(), status?.trim());
  tasks.set(task.id, task);
  res.status(201).json(task);
}

export function listTasks(req, res) {
  res.json([...tasks.values()]);
}

export function getTask(req, res, next) {
  const task = tasks.get(req.params.id);
  if (!task) return next(httpError(404, `Tâche ${req.params.id} introuvable`));
  res.json(task);
}

export function updateTask(req, res, next) {
  const task = tasks.get(req.params.id);
  if (!task) return next(httpError(404, `Tâche ${req.params.id} introuvable`));

  const { description, status } = req.body ?? {};

  if (description === undefined && status === undefined) {
    return next(httpError(400, 'Au moins un champ (description, status) doit être fourni'));
  }
  if (description !== undefined && !isNonEmptyString(description)) {
    return next(httpError(400, 'description doit être une chaîne non vide'));
  }
  if (status !== undefined && !isValidStatus(status)) {
    return next(httpError(400, INVALID_STATUS));
  }

  task.update({ description: description?.trim(), status: status?.trim() });
  res.json(task);
}

export function deleteTask(req, res, next) {
  if (!tasks.delete(req.params.id)) {
    return next(httpError(404, `Tâche ${req.params.id} introuvable`));
  }
  res.status(204).end();
}
