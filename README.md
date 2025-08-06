# Vibe Code Slop Daemon prototype

A real-time, dynamic component rendering system using GraphQL subscriptions. This architecture enables backend services to render UI components on frontend clients through a middleware daemon service.

![Architecture Flow](https://img.shields.io/badge/Flow-Registry%20→%20Daemon%20→%20Renderer-brightgreen)
![GraphQL](https://img.shields.io/badge/GraphQL-Subscriptions-E10098)
![React](https://img.shields.io/badge/React-18+-61DAFB)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933)

## 🏗️ Architecture Overview

```
┌─────────────────┐    GraphQL Sub    ┌─────────────────┐    GraphQL Sub    ┌─────────────────┐
│   Component     │─────────────────► │   Component     │─────────────────► │   Frontend      │
│   Registry      │                   │   Daemon        │                   │   Renderer      │
│   (Backend)     │                   │   (Middleware)  │                   │   (React App)   │
│                 │                   │                 │                   │                 │
│  • Manages      │                   │  • Subscribes   │                   │  • Renders UI   │
│    Components   │                   │    to Registry  │                   │  • Real-time    │
│  • REST API     │                   │  • Forwards to  │                   │  • No Business  │
│  • GraphQL      │                   │    Frontend     │                   │    Logic        │
│    Publishing   │                   │  • Middleware   │                   │  • Pure View    │
└─────────────────┘                   └─────────────────┘                   └─────────────────┘
      Port 4000                             Port 3001                           Port 3000
```

## ✨ Key Features

- **🔄 Real-time Component Delivery**: Components appear instantly via GraphQL subscriptions
- **🎨 Dynamic UI Generation**: Backend services can create UI components on-demand
- **🔧 Middleware Architecture**: Clean separation between backend and frontend
- **📱 Technology Agnostic**: Backend can be any language, frontend can be any framework
- **🚀 Scalable**: Multiple daemons and frontends can connect to same registry
- **💫 Beautiful UI**: Modern glassmorphism design with animations

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- npm or yarn
- Modern web browser

### Installation

1. **Clone and setup the project:**

   ```bash
   mkdir component-system && cd component-system
   npm init -y
   npm install apollo-server-express express graphql graphql-subscriptions subscriptions-transport-ws @graphql-tools/schema uuid ws
   ```

2. **Create the three core files:**

   - `simple-registry.js` - Component Registry backend
   - `simple-daemon.js` - Component Daemon middleware
   - React App for frontend rendering

3. **Create React frontend:**
   ```bash
   npx create-react-app frontend
   cd frontend
   # Replace src/App.js with the provided renderer code
   # Update src/index.css with the glassmorphism styles
   ```

### Running the System

Start all three services:

```bash
# Terminal 1: Run all things
npm start
```

You should see:

- ✅ Registry: `📡 Registry: New daemon subscription connected`
- ✅ Daemon: `📦 Daemon: Received component from registry`
- ✅ Frontend: `📦 Renderer: Connected to daemon`

## 🧪 Testing the System

### Basic Component Rendering

Send a card component:

```bash
curl -X POST http://localhost:4000/render \
  -H "Content-Type: application/json" \
  -d '{
    "type": "CARD",
    "data": {
      "title": "Hello World! 👋",
      "content": "This component traveled: Registry → Daemon → Renderer",
      "buttons": [
        {"text": "Awesome! 🎉"},
        {"text": "Send Another ✨"}
      ]
    }
  }'
```

### Notification Component

Send a success notification:

```bash
curl -X POST http://localhost:4000/render \
  -H "Content-Type: application/json" \
  -d '{
    "type": "NOTIFICATION",
    "data": {
      "type": "SUCCESS",
      "title": "System Working! ✅",
      "message": "Your GraphQL component flow is operational!"
    }
  }'
```

### Form Component

Send a dynamic form:

```bash
curl -X POST http://localhost:4000/render \
  -H "Content-Type: application/json" \
  -d '{
    "type": "FORM",
    "data": {
      "title": "Contact Form 📝",
      "fields": [
        {"name": "name", "label": "Your Name", "type": "text"},
        {"name": "email", "label": "Email Address", "type": "email"},
        {"name": "message", "label": "Message", "type": "text"}
      ],
      "submitText": "Send Message 🚀"
    }
  }'
```

### Error Notification

Test error handling:

```bash
curl -X POST http://localhost:4000/render \
  -H "Content-Type: application/json" \
  -d '{
    "type": "NOTIFICATION",
    "data": {
      "type": "ERROR",
      "title": "Oops! ❌",
      "message": "Something went wrong, but the system is still working!"
    }
  }'
```

## 🏛️ Component Types

### CARD

Interactive card component with title, content, and buttons.

**Structure:**

```json
{
  "type": "CARD",
  "data": {
    "title": "Card Title",
    "content": "Card description text",
    "buttons": [{ "text": "Button Text", "action": "ACTION_NAME" }]
  }
}
```

### NOTIFICATION

Status messages with different types and styling.

**Structure:**

```json
{
  "type": "NOTIFICATION",
  "data": {
    "type": "SUCCESS|ERROR|WARNING|INFO",
    "title": "Notification Title",
    "message": "Notification message",
    "dismissible": true,
    "autoRemove": 5000
  }
}
```

### FORM

Dynamic forms with configurable fields.

**Structure:**

```json
{
  "type": "FORM",
  "data": {
    "title": "Form Title",
    "fields": [
      {
        "name": "fieldName",
        "label": "Field Label",
        "type": "text|email|password",
        "placeholder": "Placeholder text"
      }
    ],
    "submitText": "Submit Button Text"
  }
}
```

## 🔧 Architecture Deep Dive

### Component Registry (`simple-registry.js`)

**Purpose**: Backend service that manages component lifecycle

- **GraphQL API**: Publishes components via subscriptions
- **REST API**: Simple HTTP interface for external services
- **Component Storage**: In-memory component management
- **Event Publishing**: Real-time updates to connected daemons

**Key Features:**

- `POST /render` - Create and publish components
- GraphQL subscription `componentUpdate` - Real-time component stream
- Auto-cleanup and TTL support

### Component Daemon (`simple-daemon.js`)

**Purpose**: Middleware that bridges registry and frontend

- **Registry Client**: Subscribes to registry component updates
- **Frontend Server**: Provides GraphQL API for frontend clients
- **Message Forwarding**: Relays components from registry to frontend
- **Connection Management**: Handles reconnections and error recovery

**Key Features:**

- WebSocket connection to registry GraphQL API
- GraphQL subscription server for frontend clients
- Real-time message forwarding
- Health monitoring and reconnection logic

### Frontend Renderer (React App)

**Purpose**: Pure UI rendering system

- **GraphQL Client**: Connects to daemon via WebSocket
- **Component Rendering**: Dynamic UI generation based on component data
- **Real-time Updates**: Live component updates without page refresh
- **Beautiful UI**: Modern glassmorphism design with animations

**Key Features:**

- WebSocket GraphQL subscription client
- Dynamic component type resolution
- Responsive design with animations
- Connection status monitoring

## 🌐 API Reference

### Registry REST API

#### Render Component

```http
POST http://localhost:4000/render
Content-Type: application/json

{
  "type": "CARD|NOTIFICATION|FORM",
  "data": { /* component data */ }
}
```

#### Health Check

```http
GET http://localhost:4000/
```

### Registry GraphQL API

#### Subscribe to Components

```graphql
subscription {
  componentUpdate {
    id
    type
    data
    createdAt
  }
}
```

### Daemon GraphQL API

#### Subscribe to Renderer Updates

```graphql
subscription {
  rendererUpdate {
    id
    type
    data
    createdAt
  }
}
```

## 🎨 Customization

### Adding New Component Types

1. **Update Registry Schema** (`simple-registry.js`):

   ```javascript
   enum ComponentType {
     CARD
     NOTIFICATION
     FORM
     TABLE        // Add new type
   }
   ```

2. **Add Renderer** (React App):
   ```javascript
   const UIRenderers = {
     // ... existing renderers
     TABLE: ({ data }) => (
       <div className="component-card">{/* Your table implementation */}</div>
     ),
   };
   ```

## 🔍 Troubleshooting

### Common Issues

**Registry not publishing components:**

- Check GraphQL subscription server is running
- Verify PubSub is using `asyncIterableIterator` method
- Ensure components are being published to correct channel

**Daemon not receiving components:**

- Verify WebSocket connection to registry
- Check GraphQL subscription query syntax
- Look for connection errors in daemon logs

**Frontend not showing components:**

- Confirm WebSocket connection to daemon
- Check browser console for connection errors
- Verify component renderer types match incoming data

### Debug Commands

**Check Registry Health:**

```bash
curl http://localhost:4000/
```

**Check Daemon Health:**

```bash
curl http://localhost:3001/
```

**Test Registry GraphQL:**

```bash
curl -X POST http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "query { components { id type } }"}'
```

### Log Analysis

**Registry Logs:**

- `📦 Registry: Publishing component` - Component created
- `📡 Registry: New daemon subscription connected` - Daemon connected

**Daemon Logs:**

- `📦 Daemon: Received component from registry` - Component received
- `📦 Daemon: Forwarding component to renderer` - Component forwarded

**Frontend Logs:**

- `📦 Renderer: Received component from daemon` - Component received
- `✅ Renderer: Connected to daemon` - Connection established

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details.

---
