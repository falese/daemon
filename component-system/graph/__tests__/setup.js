import { MongoMemoryServer } from 'mongodb-memory-server';
import { graphql } from 'graphql';
import { schema } from '../schema/index.js';
import { buildLoaders } from '../loaders/index.js';
import { connect, disconnect, mongoose } from '../models/connection.js';

export async function startInMemoryMongo() {
  const mongo = await MongoMemoryServer.create();
  await connect(mongo.getUri('daemon-graph-test'), { retries: 0 });
  return mongo;
}

export async function stopInMemoryMongo(mongo) {
  await disconnect();
  if (mongo) await mongo.stop();
}

export async function clearCollections() {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
}

export async function exec(query, variables = {}, contextOverrides = {}) {
  const result = await graphql({
    schema,
    source: query,
    variableValues: variables,
    contextValue: { loaders: buildLoaders(), ...contextOverrides }
  });
  if (result.errors && result.errors.length) {
    // Surface the first error so tests fail with a useful message
    const e = result.errors[0];
    throw new Error(`${e.message}\n${e.stack || ''}`);
  }
  return result.data;
}

export async function execRaw(query, variables = {}) {
  return graphql({
    schema,
    source: query,
    variableValues: variables,
    contextValue: { loaders: buildLoaders() }
  });
}
