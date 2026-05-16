import { pubsub, TOPICS } from '../pubsub.js';

export const SubscriptionResolvers = {
  experienceUpdated: {
    subscribe: (_p, { stateId }) =>
      pubsub.asyncIterableIterator(TOPICS.EXPERIENCE_UPDATED(stateId))
  },
  stateUpdated: {
    subscribe: (_p, { stateId }) =>
      pubsub.asyncIterableIterator(TOPICS.STATE_UPDATED(stateId))
  }
};
