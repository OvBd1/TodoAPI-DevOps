import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import app from '../../src/app.js';

let server;
let baseUrl;

before(async () => {
  // Port 0 : le système choisit un port libre, deux exécutions ne peuvent pas se marcher dessus.
  server = app.listen(0);
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

// Le stockage est un Map partagé par tout le processus : sans ce nettoyage, l'ordre des tests
// changerait leur résultat.
beforeEach(async () => {
  const { body: taches } = await api('GET', '/api/tasks');
  await Promise.all(taches.map((t) => api('DELETE', `/api/tasks/${t.id}`)));
});

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const texte = await res.text();
  return { status: res.status, body: texte === '' ? null : JSON.parse(texte) };
}

function creerTache(description = 'Tâche de test', status) {
  return api('POST', '/api/tasks', status === undefined ? { description } : { description, status });
}

describe('GET /health', () => {
  it('répond 200 avec un statut ok', async () => {
    const { status, body } = await api('GET', '/health');

    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
  });
});

describe('POST /api/tasks', () => {
  it('crée une tâche et renvoie 201 avec ce qui a été envoyé', async () => {
    const { status, body } = await creerTache('Acheter du pain');

    assert.equal(status, 201);
    assert.equal(body.description, 'Acheter du pain');
    assert.equal(body.status, 'pending');
    assert.ok(body.id);
  });

  it('accepte un statut explicite valide', async () => {
    const { status, body } = await creerTache('Écrire les tests', 'in-progress');

    assert.equal(status, 201);
    assert.equal(body.status, 'in-progress');
  });

  it('retire les espaces autour de la description', async () => {
    const { body } = await creerTache('   Acheter du pain   ');

    assert.equal(body.description, 'Acheter du pain');
  });

  it('refuse une description absente avec un 400', async () => {
    const { status, body } = await api('POST', '/api/tasks', { status: 'done' });

    assert.equal(status, 400);
    assert.match(body.error, /description/);
  });

  it('refuse une description vide ou faite d\'espaces avec un 400', async () => {
    const vide = await creerTache('');
    const espaces = await creerTache('     ');

    assert.equal(vide.status, 400);
    assert.equal(espaces.status, 400);
  });

  it('refuse une description qui n\'est pas une chaîne avec un 400', async () => {
    const { status } = await api('POST', '/api/tasks', { description: 42 });

    assert.equal(status, 400);
  });

  it('refuse un statut hors de la liste avec un 400', async () => {
    const { status, body } = await creerTache('Tâche', 'terminé');

    assert.equal(status, 400);
    assert.match(body.error, /status/);
  });

  it('refuse un corps vide avec un 400, pas une erreur serveur', async () => {
    const { status } = await api('POST', '/api/tasks');

    assert.equal(status, 400);
  });
});

describe('GET /api/tasks/:id', () => {
  it('relit une tâche par son identifiant et retrouve exactement ce qui a été envoyé', async () => {
    const { body: creee } = await creerTache('Relire cette tâche', 'done');

    const { status, body } = await api('GET', `/api/tasks/${creee.id}`);

    assert.equal(status, 200);
    assert.deepEqual(body, creee);
  });

  it('renvoie un 404 propre pour une tâche inexistante', async () => {
    const { status, body } = await api('GET', '/api/tasks/identifiant-inexistant');

    assert.equal(status, 404);
    assert.ok(body.error, 'la réponse doit porter un message d\'erreur');
  });
});

describe('GET /api/tasks', () => {
  it('renvoie une liste vide quand il n\'y a rien', async () => {
    const { status, body } = await api('GET', '/api/tasks');

    assert.equal(status, 200);
    assert.deepEqual(body, []);
  });

  it('liste les tâches créées', async () => {
    await creerTache('Première');
    await creerTache('Deuxième');

    const { body } = await api('GET', '/api/tasks');

    assert.equal(body.length, 2);
    assert.deepEqual(body.map((t) => t.description).sort(), ['Deuxième', 'Première']);
  });
});

describe('PUT /api/tasks/:id', () => {
  it('met à jour le statut et renvoie la tâche modifiée', async () => {
    const { body: creee } = await creerTache('À faire avancer');

    const { status, body } = await api('PUT', `/api/tasks/${creee.id}`, { status: 'done' });

    assert.equal(status, 200);
    assert.equal(body.status, 'done');
    assert.equal(body.id, creee.id);
  });

  it('persiste la modification', async () => {
    const { body: creee } = await creerTache('À faire avancer');
    await api('PUT', `/api/tasks/${creee.id}`, { description: 'Description corrigée' });

    const { body } = await api('GET', `/api/tasks/${creee.id}`);

    assert.equal(body.description, 'Description corrigée');
  });

  it('refuse une mise à jour sans aucun champ avec un 400', async () => {
    const { body: creee } = await creerTache('Intacte');

    const { status } = await api('PUT', `/api/tasks/${creee.id}`, {});

    assert.equal(status, 400);
  });

  it('refuse un statut invalide avec un 400', async () => {
    const { body: creee } = await creerTache('Intacte');

    const { status } = await api('PUT', `/api/tasks/${creee.id}`, { status: 'archivé' });

    assert.equal(status, 400);
  });

  it('renvoie un 404 pour une tâche inexistante', async () => {
    const { status } = await api('PUT', '/api/tasks/identifiant-inexistant', { status: 'done' });

    assert.equal(status, 404);
  });
});

describe('DELETE /api/tasks/:id', () => {
  it('supprime la tâche, qui disparaît aussi de la liste', async () => {
    const { body: creee } = await creerTache('À supprimer');

    const suppression = await api('DELETE', `/api/tasks/${creee.id}`);
    const relecture = await api('GET', `/api/tasks/${creee.id}`);
    const { body: liste } = await api('GET', '/api/tasks');

    assert.equal(suppression.status, 204);
    assert.equal(relecture.status, 404);
    assert.deepEqual(liste, []);
  });

  it('renvoie un 404 pour une tâche inexistante', async () => {
    const { status } = await api('DELETE', '/api/tasks/identifiant-inexistant');

    assert.equal(status, 404);
  });
});
