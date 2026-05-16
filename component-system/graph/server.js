import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { createServer } from 'http';
import { useServer } from 'graphql-ws/use/ws';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

import { schema } from './schema/index.js';
import { buildLoaders } from './loaders/index.js';
import { connect, disconnect, mongoose } from './models/connection.js';

export async function startServer({ mongoUri, port }) {
  await connect(mongoUri);

  const app = express();
  const httpServer = createServer(app);

  app.get('/', (_req, res) => {
    res.json({
      service: 'control-plane-graph',
      mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      endpoints: { GraphQL: '/graphql' }
    });
  });

  // Subscriptions: graphql-transport-ws over the same /graphql path.
  const wsServer = new WebSocketServer({ server: httpServer, path: '/graphql' });
  const wsCleanup = useServer(
    {
      schema,
      context: () => ({ loaders: buildLoaders() })
    },
    wsServer
  );

  const apollo = new ApolloServer({
    schema,
    plugins: [
      // Drain HTTP connections gracefully on shutdown.
      ApolloServerPluginDrainHttpServer({ httpServer }),
      // Also dispose the ws server when Apollo stops.
      {
        async serverWillStart() {
          return {
            async drainServer() {
              await wsCleanup.dispose();
            }
          };
        }
      }
    ]
  });
  await apollo.start();

  app.use(
    '/graphql',
    cors(),
    express.json(),
    expressMiddleware(apollo, {
      context: async () => ({ loaders: buildLoaders() })
    })
  );

  await new Promise((resolve) => httpServer.listen(port, '0.0.0.0', resolve));
  console.log(`🚀 Graph listening on http://0.0.0.0:${port}`);
  console.log(`   GraphQL: http://0.0.0.0:${port}/graphql`);

  async function stop() {
    await apollo.stop();
    await new Promise((resolve) => httpServer.close(resolve));
    await disconnect();
  }

  return { httpServer, apollo, wsServer, stop };
}
