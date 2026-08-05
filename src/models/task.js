import { randomUUID } from 'node:crypto';

class Task {
  static STATUSES = Object.freeze(['pending', 'in-progress', 'done']);
  static DESCRIPTION_MAX = 500;

  static fromRow(row) {
    const task = Object.create(Task.prototype);
    task.id = row.id;
    task.description = row.description;
    task.status = row.status;
    task.createdAt = row.created_at;
    task.updatedAt = row.updated_at;
    return task;
  }

  constructor(description, status = 'pending') {
    this.id = randomUUID();
    this.description = description;
    this.status = status;
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  update({ description, status }) {
    if (description !== undefined) this.description = description;
    if (status !== undefined) this.status = status;
    this.updatedAt = new Date();
  }
}

export default Task;
