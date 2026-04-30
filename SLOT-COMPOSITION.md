# Slot-Based Composition

This document explains how the control plane composes the UI by managing slots — named holes that components declare and the daemon fills.

## The Core Idea

A component announces that it has a named hole in its layout. It never decides what goes there. The daemon holds the only authoritative map of what fills each slot, and it broadcasts that map to renderers as assignments change.

```
Component says:  "I have a hole called 'detail'"
Registry says:   "put this notification into the 'detail' hole of that card"
Daemon decides:  slot[cardId]['detail'] = notificationId   ← single source of truth
Renderer shows:  whatever the daemon says is in that slot
```

---

## Separation of Concerns

Each layer owns exactly one responsibility:

| Layer | Owns | Does NOT own |
|---|---|---|
| **Component** (`slots: string[]`) | Declaring that a named slot exists | Knowing what will fill it |
| **Registry rules** (`data._slot`) | Expressing routing *intent* | Enforcing or validating assignments |
| **Daemon** (`slotAssignments` map) | The authoritative slot map; broadcasting assignments | Rendering; layout; business rules |
| **Renderer** (`ComponentDisplaySystem.slotMap`) | Rendering whatever the daemon assigned | Fetching or selecting slot contents |

The invariant: **nothing downstream of the daemon can put a component into a slot**. Only the daemon writes `slotAssignments`.

---

## Data Flow

### When a slotted component arrives

```
1. Registry rule fires
   └─ generate() returns a component with data._slot = { parentId, slotName }
      This is routing INTENT, not enforcement.

2. Registry publishes componentUpdate subscription
   └─ The component travels to the daemon over the persistent WS subscription.

3. Daemon: storeComponent(component)
   ├─ Upserts component into componentState cache
   └─ resolveSlotAssignment(component)
        ├─ Reads data._slot.parentId and data._slot.slotName
        ├─ Looks up parent in componentState cache
        ├─ Validates parent.slots.includes(slotName)  ← guard: slot must be declared
        ├─ Updates slotAssignments map
        └─ publishSlotAssignment(parentId, slotName, childId)

4. Daemon publishes two messages to renderers (in this order):
   ├─ SLOT_ASSIGNMENT  { parentComponentId, slotName, childComponentId }
   └─ COMPONENT_UPDATE  { the child component itself }

5. Renderer receives SLOT_ASSIGNMENT:
   └─ slotMap.get(parentId).set(slotName, childId)   ← stores ID, not object

6. Renderer receives COMPONENT_UPDATE:
   └─ components.get(childId) now resolves
      Next render: getSlots(parentId) returns { detail: <component object> }

7. React renders the parent component with slots prop:
   ├─ slotNames.includes('detail') → render the slot section
   ├─ SlotRenderer receives the resolved child component
   └─ Child renders inside the parent's layout
```

> **Why store the ID and not the object?** `SLOT_ASSIGNMENT` is published *before* `COMPONENT_UPDATE` for the same child (because `resolveSlotAssignment` runs inside `storeComponent`, before the `COMPONENT_UPDATE` publish). Storing the ID and resolving it lazily in `getSlots()` means the renderer always gets the current object on each render, regardless of message order.

### When a slot is explicitly assigned

The daemon exposes an `assignSlot` GraphQL mutation for cases where no registry rule is involved (tests, admin tools, external orchestrators):

```graphql
mutation {
  assignSlot(parentId: "card-id", slotName: "detail", childId: "notif-id")
}
```

This calls the same `publishSlotAssignment` path as the automatic resolution — the renderer can't distinguish the two.

---

## Wire Protocol

`SLOT_ASSIGNMENT` uses the existing message envelope:

```json
{
  "direction": "COMPONENT",
  "kind": "SLOT_ASSIGNMENT",
  "payload": {
    "parentComponentId": "abc-123",
    "slotName": "detail",
    "childComponentId": "xyz-789"
  },
  "metadata": { "acknowledged": false, "correlationId": "...", "error": null }
}
```

Set `childComponentId` to `null` to clear a slot.

---

## How to Declare a Slot

A component declares its slots in the top-level `slots` array — **not** inside `data`:

```javascript
// Registry rule generate():
{
  type: 'CARD',
  slots: ['detail'],        // ← top-level, not data.slots
  data: {
    title: 'My Card',
    content: '...'
  }
}
```

The `slots` array is the contract between the component and the daemon. The daemon will only accept assignments for slot names present in this array.

---

## How to Route a Component Into a Slot

In a registry rule's `generate()`, attach a `_slot` directive to `data`:

```javascript
{
  type: 'NOTIFICATION',
  data: {
    message: 'Done!',
    status: 'SUCCESS',
    _slot: {
      parentId: state.component.id,   // ← ID of the parent that declared the slot
      slotName: 'detail'              // ← must match an entry in parent.slots
    }
  }
}
```

The daemon strips meaning from `_slot` by validating and resolving it — the `NOTIFICATION` component object that reaches the renderer has `_slot` in its `data`, but the renderer ignores it. The renderer only reads the `slots` prop it receives from `ComponentDisplaySystem`.

---

## How Renderers Use Slots

The `App` component passes two props to every UIRenderer:

| Prop | Type | Source |
|---|---|---|
| `slotNames` | `string[]` | `component.slots` — the declared slot names |
| `slots` | `{ [slotName]: Component \| null }` | `displaySystem.getSlots(component.id)` — daemon assignments, resolved |

A renderer uses `slotNames` to decide *whether* to show a slot section, and `slots` to get *what* to put in it:

```jsx
const CARD = ({ data, componentId, onAction, slots = {}, slotNames = [] }) => (
  <div>
    {/* ... card content ... */}

    {slotNames.includes('detail') && (
      <div className="slot-region">
        <SlotRenderer component={slots.detail ?? null} onAction={onAction} />
      </div>
    )}
  </div>
);
```

`SlotRenderer` is a pure display component — it receives a component object (or `null`) and renders it using the normal `UIRenderers` dispatch. It has no knowledge of which parent it belongs to or why it was placed there.

---

## How Slotted Components Are Hidden from the Top-Level List

When the renderer renders the component list, it suppresses any component that is currently assigned to a slot:

```javascript
// ComponentDisplaySystem
isSlotted(componentId) {
  for (const slotsByName of this.slotMap.values()) {
    for (const childId of slotsByName.values()) {
      if (childId === componentId) return true;
    }
  }
  return false;
}
```

```jsx
// App
components.map(component => {
  if (displaySystem.isSlotted(component.id)) return null;  // renders inside parent instead
  // ...
})
```

This means a NOTIFICATION that has been slotted into a CARD will not appear as a standalone card in the list — it appears only inside the CARD's slot section.

---

## The Default Demo

The built-in rules demonstrate slots end-to-end:

```
make form          → injects a FORM component

Submit the form    → form-submit rule fires
                   → creates a CARD with slots: ['detail']

Click the card     → card-click rule fires
                   → creates a NOTIFICATION with data._slot pointing at the CARD's 'detail' slot
                   → daemon resolves the assignment
                   → NOTIFICATION appears inside the CARD, not below it
```

---

## Adding a New Slot

1. **Declare the slot** on the component that will host it:
   ```javascript
   // In a registry rule's generate(), or in a direct renderComponent call:
   { type: 'CARD', slots: ['detail', 'footer'], data: { ... } }
   ```

2. **Route components into it** from a rule:
   ```javascript
   generate: (state, _action) => ({
     type: 'BADGE',
     data: {
       label: 'New',
       _slot: { parentId: state.component.id, slotName: 'footer' }
     }
   })
   ```

3. **Render it** in the UIRenderer:
   ```jsx
   {slotNames.includes('footer') && (
     <SlotRenderer component={slots.footer ?? null} onAction={onAction} />
   )}
   ```

No changes to the daemon, message protocol, or `ComponentDisplaySystem` are required.
