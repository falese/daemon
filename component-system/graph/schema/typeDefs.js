export const typeDefs = `
  scalar JSON
  scalar DateTime

  enum NodeKind {
    STATE_OBJECT
    EXPERIENCE
  }

  union LayoutChild = Layout | Component

  # ────────────────────────────────────────────────────────────────────────────
  # The runtime cursor over the experience graph.
  # ────────────────────────────────────────────────────────────────────────────
  type StateObject {
    id: ID!
    type: String!
    data: JSON!
    version: Int!
    createdAt: DateTime!
    updatedAt: DateTime!

    # Null if the cursor is still on the StateObject itself (no transition fired yet).
    currentExperience: Experience

    # Outgoing edges from the current node, excluding edges already satisfied.
    availableTransitions: [Transition!]!

    # Edges this state has already consumed (once-only semantics).
    satisfiedEdges: [Transition!]!

    # true when availableTransitions is empty — the machine has terminated.
    isTerminal: Boolean!
  }

  # ────────────────────────────────────────────────────────────────────────────
  # An action-typed edge in the state machine.
  # ────────────────────────────────────────────────────────────────────────────
  type Transition {
    id: ID!
    sourceNodeId: ID!
    sourceKind: NodeKind!
    actionType: String!
    targetExperience: Experience!
    metadata: JSON
  }

  # ────────────────────────────────────────────────────────────────────────────
  # The top-level UI container. A graph node, not a leaf — Experiences can have
  # their own outgoing transitions.
  # ────────────────────────────────────────────────────────────────────────────
  type Experience {
    id: ID!
    name: String!
    createdAt: DateTime!
    layouts: [Layout!]!
    outgoingTransitions: [Transition!]!
  }

  type Layout {
    id: ID!
    type: String!
    createdAt: DateTime!
    children: [LayoutChild!]!
  }

  type Component {
    id: ID!
    type: String!
    data: JSON!
    parentId: ID
    createdAt: DateTime!
    parent: Component
    children: [Component!]!
  }

  type Query {
    stateObject(id: ID!): StateObject
    stateObjects: [StateObject!]!
    experience(id: ID!): Experience
    currentExperience(stateId: ID!): Experience
  }

  input ActionInput {
    type: String!
    data: JSON
  }

  type MutateStateResult {
    state: StateObject!
    experience: Experience
    transitioned: Boolean!
    terminal: Boolean!
  }

  type Mutation {
    createStateObject(type: String!, data: JSON): StateObject!
    createExperience(name: String!): Experience!
    createLayout(type: String!, experienceId: ID): Layout!
    createComponent(
      type: String!
      data: JSON
      parentLayoutId: ID
      parentComponentId: ID
    ): Component!

    addChildLayout(parentLayoutId: ID!, childLayoutId: ID!): Layout!
    addChildComponent(
      parentId: ID!
      parentKind: String!
      childComponentId: ID!
    ): ID!

    addTransition(
      sourceNodeId: ID!
      sourceKind: NodeKind!
      actionType: String!
      targetExperienceId: ID!
      metadata: JSON
    ): Transition!

    mutateState(id: ID!, action: ActionInput!): MutateStateResult!

    resetState(id: ID!): StateObject!
  }

  type ExperienceEvent {
    stateId: ID!
    experience: Experience!
    actionType: String!
    terminal: Boolean!
  }

  type Subscription {
    experienceUpdated(stateId: ID!): ExperienceEvent!
    stateUpdated(stateId: ID!): StateObject!
  }
`;
