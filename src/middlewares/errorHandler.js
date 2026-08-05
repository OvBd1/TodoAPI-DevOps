export default (err, req, res, next) => {
  const status = err.status || 500;

  // Une erreur 4xx est une faute du client, pas une panne : la journaliser en erreur
  // noierait les vraies pannes serveur dans le bruit.
  if (status >= 500) {
    console.error(err);
  }

  res.status(status).json({ error: err.message || 'Internal Server Error' });
};
