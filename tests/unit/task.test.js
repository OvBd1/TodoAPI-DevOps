import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Task from '../../src/models/task.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('Task — construction', () => {
  it('renseigne la description et le statut par défaut', () => {
    const task = new Task('Acheter du pain');

    assert.equal(task.description, 'Acheter du pain');
    assert.equal(task.status, 'pending');
  });

  it('accepte un statut explicite', () => {
    const task = new Task('Écrire les tests', 'in-progress');

    assert.equal(task.status, 'in-progress');
  });

  it('génère un identifiant unique au format UUID', () => {
    const premier = new Task('A');
    const second = new Task('B');

    assert.match(premier.id, UUID_V4);
    assert.notEqual(premier.id, second.id);
  });

  it('horodate la création, createdAt et updatedAt partant identiques', () => {
    const task = new Task('A');

    assert.ok(task.createdAt instanceof Date);
    assert.ok(task.updatedAt instanceof Date);
    assert.equal(task.updatedAt.getTime(), task.createdAt.getTime());
  });
});

describe('Task — statuts autorisés', () => {
  it('expose exactement les trois statuts du domaine', () => {
    assert.deepEqual(Task.STATUSES, ['pending', 'in-progress', 'done']);
  });

  it('protège la liste contre toute modification', () => {
    assert.ok(Object.isFrozen(Task.STATUSES));
  });
});

describe('Task — update()', () => {
  // Chaque test repart d'une tâche neuve dont on recule updatedAt dans le passé :
  // c'est ce qui rend l'avancement de l'horodatage observable sans dépendre du temps réel.
  function tacheDatee() {
    const task = new Task('Description initiale');
    task.updatedAt = new Date(0);
    return task;
  }

  it('modifie la description seule', () => {
    const task = tacheDatee();

    task.update({ description: 'Nouvelle description' });

    assert.equal(task.description, 'Nouvelle description');
    assert.equal(task.status, 'pending');
  });

  it('modifie le statut seul', () => {
    const task = tacheDatee();

    task.update({ status: 'done' });

    assert.equal(task.status, 'done');
    assert.equal(task.description, 'Description initiale');
  });

  it('modifie les deux champs à la fois', () => {
    const task = tacheDatee();

    task.update({ description: 'Tout change', status: 'in-progress' });

    assert.equal(task.description, 'Tout change');
    assert.equal(task.status, 'in-progress');
  });

  it('laisse les champs intacts quand rien n\'est fourni', () => {
    const task = tacheDatee();

    task.update({});

    assert.equal(task.description, 'Description initiale');
    assert.equal(task.status, 'pending');
  });

  it('fait avancer updatedAt sans toucher à createdAt', () => {
    const task = tacheDatee();
    const creation = task.createdAt.getTime();

    task.update({ status: 'done' });

    assert.ok(task.updatedAt.getTime() > 0, 'updatedAt doit être réhorodaté');
    assert.equal(task.createdAt.getTime(), creation);
  });
});
