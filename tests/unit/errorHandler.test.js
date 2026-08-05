import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import errorHandler from '../../src/middlewares/errorHandler.js';

// Faux objet réponse : on enregistre ce que le middleware appelle, sans serveur HTTP.
function fausseReponse() {
  const res = { statusEnvoye: null, corpsEnvoye: null };
  res.status = (code) => {
    res.statusEnvoye = code;
    return res;
  };
  res.json = (corps) => {
    res.corpsEnvoye = corps;
    return res;
  };
  return res;
}

describe('errorHandler — code de statut', () => {
  it('reprend le statut porté par l\'erreur', () => {
    const res = fausseReponse();

    errorHandler(Object.assign(new Error('introuvable'), { status: 404 }), {}, res, () => {});

    assert.equal(res.statusEnvoye, 404);
    assert.deepEqual(res.corpsEnvoye, { error: 'introuvable' });
  });

  it('retombe sur 500 quand l\'erreur n\'en porte pas', () => {
    const res = fausseReponse();

    errorHandler(new Error('boum'), {}, res, () => {});

    assert.equal(res.statusEnvoye, 500);
  });

  it('fournit un message par défaut si l\'erreur n\'en a pas', () => {
    const res = fausseReponse();

    errorHandler(new Error(''), {}, res, () => {});

    assert.deepEqual(res.corpsEnvoye, { error: 'Internal Server Error' });
  });
});

describe('errorHandler — journalisation', () => {
  it('ne journalise pas les erreurs client (4xx)', (t) => {
    const journal = t.mock.method(console, 'error', () => {});

    errorHandler(Object.assign(new Error('invalide'), { status: 400 }), {}, fausseReponse(), () => {});
    errorHandler(Object.assign(new Error('introuvable'), { status: 404 }), {}, fausseReponse(), () => {});

    assert.equal(journal.mock.callCount(), 0, 'un 4xx est une faute du client, pas une panne');
  });

  it('journalise les pannes serveur (5xx)', (t) => {
    const journal = t.mock.method(console, 'error', () => {});

    errorHandler(new Error('base injoignable'), {}, fausseReponse(), () => {});

    assert.equal(journal.mock.callCount(), 1);
  });
});
