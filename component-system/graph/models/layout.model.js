import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

const { Schema } = mongoose;

// Layouts contain heterogeneous children (nested Layouts OR Components).
// children[].kind discriminates which collection ref points into.
const LayoutSchema = new Schema(
  {
    _id: { type: String, default: () => uuidv4() },
    type: { type: String, required: true },
    children: {
      type: [
        {
          _id: false,
          kind: { type: String, enum: ['Layout', 'Component'], required: true },
          ref: { type: String, required: true }
        }
      ],
      default: []
    }
  },
  { timestamps: true, _id: false }
);

export const Layout =
  mongoose.models.Layout || mongoose.model('Layout', LayoutSchema);
