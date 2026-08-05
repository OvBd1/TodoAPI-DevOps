import client from 'prom-client';

export const registry = new client.Registry();

client.collectDefaultMetrics({ register: registry });

export const requetes = new client.Counter({
  name: 'http_requests_total',
  help: 'Nombre total de requetes HTTP servies',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

export const duree = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duree des requetes HTTP en secondes',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const tachesCreees = new client.Counter({
  name: 'todo_tasks_created_total',
  help: 'Nombre de taches creees depuis le demarrage',
  registers: [registry],
});

// A monter en tete de chaque routeur : sur un next(err), Express restaure req.baseUrl avant
// d'atteindre le middleware d'erreur, et le prefixe serait perdu au moment de l'etiquetage.
export function marquerPrefixe(req, res, next) {
  req.prefixeRoute = req.baseUrl;
  next();
}

// Le motif de la route, jamais l'URL : /api/tasks/:id et non /api/tasks/8f2c-...
// Sinon chaque identifiant de tache creerait une serie temporelle de plus.
function libelleRoute(req) {
  if (!req.route) return '(inconnue)';
  const chemin = `${req.prefixeRoute ?? req.baseUrl}${req.route.path}`;
  return chemin.length > 1 ? chemin.replace(/\/$/, '') : chemin;
}

export function mesurer(req, res, next) {
  const fin = duree.startTimer();

  res.on('finish', () => {
    const etiquettes = {
      method: req.method,
      route: libelleRoute(req),
      status: String(res.statusCode),
    };
    requetes.inc(etiquettes);
    fin(etiquettes);
  });

  next();
}
