import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import app from '../../src/app.js';
import { close } from '../../src/db.js';

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  // La base est coupee pour tout ce fichier : le pool ne pourra plus joindre personne.
  await close();
});

after(() => new Promise((resolve) => server.close(resolve)));

describe('Signature d\'une base injoignable', () => {
  it('/health répond toujours 200 : l\'API est vivante', async () => {
    const res = await fetch(`${baseUrl}/health`);

    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'ok');
  });

  it('/metrics répond toujours : la supervision survit à la panne', async () => {
    const res = await fetch(`${baseUrl}/metrics`);

    assert.equal(res.status, 200);
    assert.match(await res.text(), /http_requests_total/);
  });

  it('/api/tasks répond 500 et non un plantage du processus', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`);

    assert.equal(res.status, 500);
  });

  it('le processus est toujours debout après ces erreurs', async () => {
    const res = await fetch(`${baseUrl}/health`);

    assert.equal(res.status, 200, 'une erreur base ne doit jamais tuer le serveur');
  });
});
