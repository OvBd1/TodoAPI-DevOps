import { close, migrate } from '../src/db.js';

await migrate();
await close();
console.log('schema en place');
