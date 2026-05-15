import { ApolloServer } from 'apollo-server-express';
import { createServer } from 'http';
import { useServer } from 'graphql-ws/use/ws';
import express from 'express';
import { WebSocketServer } from 'ws';

import { schema } from './schema/index.js';
import { buildLoaders } from './loaders/index.js';
import { connect, disconnect, mongoose } from './models/connection.js';

export async function startServer({ mongoUri, port }) {
  await connect(mongoUri);

  const app = express();
  const httpServer = createServer(app);

  app.use(express.json());

  app.get('/', (_req, res) => {
    res.json({
      service: 'control-plane-graph',
      mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      endpoints: { GraphQL: '/graphql' }
    });
  });

  const apollo = new ApolloServer({
    schema,
    context: () => ({ loaders: buildLoaders() })
  });
  await apollo.start();
  apollo.applyMiddleware({ app, path: '/graphql' });

  const wsServer = new WebSocketServer({ server: httpServer, path: '/graphql' });
  useServer(
    {
      schema,
      context: () => ({ loaders: buildLoaders() })
    },
    wsServer
  );

  await new Promise((resolve) => httpServer.listen(port, '0.0.0.0', resolve));
  console.log(`🚀 Graph listening on http://0.0.0.0:${port}`);
  console.log(`   GraphQL: http://0.0.0.0:${port}/graphql`);

  async function stop() {
    await apollo.stop();
    wsServer.close();
    await new Promise((resolve) => httpServer.close(resolve));
    await disconnect();
  }

  return { httpServer, apollo, wsServer, stop };
}
