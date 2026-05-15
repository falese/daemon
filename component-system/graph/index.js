import { startServer } from './server.js';

const port = parseInt(process.env.GRAPH_PORT || process.env.PORT || '4100', 10);
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/daemon-graph';

startServer({ port, mongoUri }).catch((err) => {
  console.error('❌ Graph failed to start:', err);
  process.exit(1);
});
