import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

const { Schema } = mongoose;

const StateObjectSchema = new Schema(
  {
    _id: { type: String, default: () => uuidv4() },
    type: { type: String, required: true },
    data: { type: Schema.Types.Mixed, default: {} },
    // Runtime cursor over the experience graph.
    // Initially the state itself is the starting node (sourceKind === 'StateObject').
    // After the first successful transition, currentNodeKind becomes 'Experience'
    // and currentNodeId points at the active Experience.
    currentNodeId: { type: String, default: null },
    currentNodeKind: {
      type: String,
      enum: ['StateObject', 'Experience'],
      default: 'StateObject'
    },
    // Edges already consumed by this state. Enforces "satisfied" semantics:
    // a transition fires at most once per state.
    satisfiedEdgeIds: { type: [String], default: [] },
    version: { type: Number, default: 0 }
  },
  { timestamps: true, _id: false }
);

// On first save, point the cursor at this state's own id so traversal can find
// edges with sourceKind='StateObject', sourceNodeId=this._id.
StateObjectSchema.pre('save', function (next) {
  if (this.isNew && this.currentNodeId === null) {
    this.currentNodeId = this._id;
  }
  next();
});

export const StateObject =
  mongoose.models.StateObject || mongoose.model('StateObject', StateObjectSchema);
