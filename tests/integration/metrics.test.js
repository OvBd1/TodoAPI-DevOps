import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import app from '../../src/app.js';
import { close, query } from '../../src/db.js';

let server;
let baseUrl;

before(async () => {
  await query('TRUNCATE TABLE tasks');
  server = app.listen(0);
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await close();
});

async function metriques() {
  const res = await fetch(`${baseUrl}/metrics`);
  return { contentType: res.headers.get('content-type'), texte: await res.text() };
}

// Lit la valeur d'une serie precise dans la sortie Prometheus.
function valeur(texte, motif) {
  const ligne = texte.split('\n').find((l) => l.startsWith(motif));
  return ligne ? Number(ligne.slice(ligne.lastIndexOf(' ') + 1)) : 0;
}

describe('GET /metrics', () => {
  it('répond en texte brut, jamais en JSON', async () => {
    const { contentType, texte } = await metriques();

    assert.match(contentType, /^text\/plain/);
    assert.doesNotMatch(contentType, /json/);
    assert.match(texte, /^# HELP /m);
    assert.match(texte, /^# TYPE /m);
  });

  it('expose les trois familles de métriques attendues', async () => {
    const { texte } = await metriques();

    assert.match(texte, /^# TYPE http_requests_total counter$/m);
    assert.match(texte, /^# TYPE http_request_duration_seconds histogram$/m);
    assert.match(texte, /^# TYPE todo_tasks_created_total counter$/m);
  });

  it('fournit les quantiles de latence via les buckets de l\'histogramme', async () => {
    await fetch(`${baseUrl}/health`);
    const { texte } = await metriques();

    assert.match(texte, /http_request_duration_seconds_bucket\{.*le="0\.1".*\}/);
    assert.match(texte, /http_request_duration_seconds_sum\{/);
    assert.match(texte, /http_request_duration_seconds_count\{/);
  });
});

describe('Comptage des requêtes', () => {
  it('augmente de 3 exactement après 3 appels sur la même route', async () => {
    const motif = 'http_requests_total{method="GET",route="/health",status="200"}';

    const avant = valeur((await metriques()).texte, motif);
    await fetch(`${baseUrl}/health`);
    await fetch(`${baseUrl}/health`);
    await fetch(`${baseUrl}/health`);
    const apres = valeur((await metriques()).texte, motif);

    assert.equal(apres - avant, 3);
  });

  it('compte aussi les routes inconnues qui finissent en 404', async () => {
    const motif = 'http_requests_total{method="GET",route="(inconnue)",status="404"}';

    const avant = valeur((await metriques()).texte, motif);
    await fetch(`${baseUrl}/cette-route-nexiste-pas`);
    const apres = valeur((await metriques()).texte, motif);

    assert.equal(apres - avant, 1, 'sans ça, la moitié des erreurs devient invisible');
  });

  it('distingue les codes de statut sur une même route', async () => {
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'comptee' }),
    });
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const { texte } = await metriques();

    assert.ok(valeur(texte, 'http_requests_total{method="POST",route="/api/tasks",status="201"}') > 0);
    assert.ok(valeur(texte, 'http_requests_total{method="POST",route="/api/tasks",status="400"}') > 0);
  });
});

describe('Cardinalité des étiquettes', () => {
  it('n\'utilise jamais l\'identifiant d\'une tâche comme étiquette', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'sa description importe peu' }),
    });
    const { id } = await res.json();

    await fetch(`${baseUrl}/api/tasks/${id}`);
    const { texte } = await metriques();

    assert.ok(!texte.includes(id), `l'identifiant ${id} ne doit pas apparaître dans /metrics`);
    assert.match(texte, /route="\/api\/tasks\/:id"/);
  });
});

describe('Métrique métier', () => {
  it('compte les tâches créées, et seulement celles qui aboutissent', async () => {
    const motif = 'todo_tasks_created_total';

    const avant = valeur((await metriques()).texte, motif);
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'une vraie tache' }),
    });
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: '' }),
    });
    const apres = valeur((await metriques()).texte, motif);

    assert.equal(apres - avant, 1, 'une création refusée ne doit pas être comptée');
  });
});
