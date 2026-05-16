import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

const { Schema } = mongoose;

// Components compose other Components (recursive UI tree leaves).
const ComponentSchema = new Schema(
  {
    _id: { type: String, default: () => uuidv4() },
    type: { type: String, required: true },
    data: { type: Schema.Types.Mixed, default: {} },
    parentId: { type: String, default: null },
    parentKind: {
      type: String,
      enum: ['Component', 'Layout', null],
      default: null
    },
    children: {
      type: [
        {
          _id: false,
          kind: { type: String, enum: ['Component'], default: 'Component' },
          ref: { type: String, required: true }
        }
      ],
      default: []
    }
  },
  { timestamps: true, _id: false }
);

export const Component =
  mongoose.models.Component || mongoose.model('Component', ComponentSchema);
