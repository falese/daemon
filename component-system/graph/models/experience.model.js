import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

const { Schema } = mongoose;

const ExperienceSchema = new Schema(
  {
    _id: { type: String, default: () => uuidv4() },
    name: { type: String, required: true },
    // Layouts attached to this Experience. Each entry is { kind: 'Layout', ref: <layoutId> }
    // to keep the shape symmetric with Layout.children and to leave room for richer
    // attachment metadata later without a schema migration.
    layouts: {
      type: [
        {
          _id: false,
          kind: { type: String, enum: ['Layout'], default: 'Layout' },
          ref: { type: String, required: true }
        }
      ],
      default: []
    }
  },
  { timestamps: true, _id: false }
);

export const Experience =
  mongoose.models.Experience || mongoose.model('Experience', ExperienceSchema);
