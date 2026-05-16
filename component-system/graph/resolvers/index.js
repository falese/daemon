import { JSONScalar, DateTimeScalar } from '../schema/scalars.js';
import { QueryResolvers } from './query.js';
import { MutationResolvers } from './mutation.js';
import { SubscriptionResolvers } from './subscription.js';
import { StateObjectResolvers } from './stateObject.js';
import { TransitionResolvers } from './transition.js';
import { ExperienceResolvers } from './experience.js';
import { LayoutResolvers, LayoutChildResolvers } from './layout.js';
import { ComponentResolvers } from './component.js';

export const resolvers = {
  JSON: JSONScalar,
  DateTime: DateTimeScalar,

  Query: QueryResolvers,
  Mutation: MutationResolvers,
  Subscription: SubscriptionResolvers,

  StateObject: StateObjectResolvers,
  Transition: TransitionResolvers,
  Experience: ExperienceResolvers,
  Layout: LayoutResolvers,
  LayoutChild: LayoutChildResolvers,
  Component: ComponentResolvers
};
