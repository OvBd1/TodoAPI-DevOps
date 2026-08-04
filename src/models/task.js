import { randomUUID } from 'node:crypto';

class Task {
  static STATUSES = Object.freeze(['pending', 'in-progress', 'done']);

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
