import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import taskRoutes from './routes/tasks.js';
import errorHandler from './middlewares/errorHandler.js';
import { mesurer, registry } from './metrics.js';

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

// Avant les routes, pour voir passer toutes les requêtes — y compris celles qui finissent en 404.
app.use(mesurer);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', registry.contentType);
  res.send(await registry.metrics());
});

app.use('/api/tasks', taskRoutes);

app.use(errorHandler);

if (import.meta.main) {
  const PORT = process.env.PORT || 3000;
  const { migrate } = await import('./db.js');
  await migrate();
  app.listen(PORT, () => console.log(`API à l'écoute sur le port ${PORT}`));
}

export default app;

