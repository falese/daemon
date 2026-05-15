import { PubSub } from 'graphql-subscriptions';

export const pubsub = new PubSub();

export const TOPICS = {
  EXPERIENCE_UPDATED: (stateId) => `EXPERIENCE_UPDATED:${stateId}`,
  STATE_UPDATED: (stateId) => `STATE_UPDATED:${stateId}`
};
