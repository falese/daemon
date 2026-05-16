import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

const { Schema } = mongoose;

// A Transition is the enforceable edge in the experience graph.
// Source can be either a StateObject (start of the machine) or an Experience
// (an intermediate node). Target is always an Experience in v1.
const TransitionSchema = new Schema(
  {
    _id: { type: String, default: () => uuidv4() },
    sourceNodeId: { type: String, required: true },
    sourceKind: {
      type: String,
      enum: ['StateObject', 'Experience'],
      required: true
    },
    actionType: { type: String, required: true },
    targetExperienceId: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} }
  },
  { timestamps: true, _id: false }
);

// Enforcement: a given (source, action) pair must produce a single, deterministic edge.
TransitionSchema.index(
  { sourceNodeId: 1, sourceKind: 1, actionType: 1 },
  { unique: true }
);
// Hot path: every mutateState() looks up edges by source.
TransitionSchema.index({ sourceNodeId: 1, sourceKind: 1 });

export const Transition =
  mongoose.models.Transition || mongoose.model('Transition', TransitionSchema);
