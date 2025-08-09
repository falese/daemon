# Vibe Coded Slop Daemon

A distributed, real-time component rendering system built with GraphQL, Rust, Node.js, and React. This architecture enables dynamic UI updates across multiple renderers through a high-performance daemon service.

![Architecture](https://img.shields.io/badge/Architecture-Microservices-blue)
![Rust](https://img.shields.io/badge/Rust-Daemon-orange)
![GraphQL](https://img.shields.io/badge/GraphQL-Subscriptions-E10098)
![React](https://img.shields.io/badge/React-Frontend-61DAFB)
![Docker](https://img.shields.io/badge/Docker-Containers-2496ED)

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

- Docker and Docker Compose
- Modern web browser (for accessing renderers)
- curl (for testing)

### Installation

1. **Clone the repository:**

   ```bash
   git clone <repository-url>
   cd daemon
   ```

2. **Start services using Make:**

   ```bash
   # Build all images
   make build

   # Start everything at once
   make all

   # OR use interactive stack launcher
   make stack  # Guides you through daemon and renderer selection
   ```

The `make stack` command provides an interactive way to choose:

- Which daemon to run (Rust or Node.js)
- Which renderer to use (React or HTML)

Individual commands are also available:

- `make rust-daemon` - Start the Rust daemon
- `make node-daemon` - Start the Node.js daemon
- `make react-renderer` - Start the React frontend
- `make html-renderer` - Start the HTML renderer

This will start the selected services:

- Registry (Node.js) on port 4000
- Rust Daemon on port 3001 (if selected)
- Node Daemon on port 3002 (if selected)
- React Renderer on port 3000 (if selected)
- HTML Renderer on port 8081 (if selected)

### Verifying the System

After starting the services with Docker Compose, verify each component:

1. **Check service status:**

   ```bash
   docker-compose ps
   ```

   All services should show as "Up"

2. **Check component health:**

   - Registry: Visit http://localhost:4000
   - Rust Daemon: Visit http://localhost:3001
   - React Renderer: Visit http://localhost:3000
   - HTML Renderer: Visit http://localhost:8081

3. **View service logs:**
   ```bash
   docker-compose logs -f
   ```

You should see:

- ✅ Registry: Service ready on port 4000
- ✅ Rust Daemon: Connected to registry
- ✅ Node Daemon: Connected to registry
- ✅ React Renderer: WebSocket connection established
- ✅ HTML Renderer: Server running

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

### Service Roles

1. **Registry (`registry/simple-registry.js`)**

   - Node.js service managing component lifecycle
   - GraphQL subscriptions for real-time updates
   - REST API for component creation
   - In-memory component management
   - Runs in Docker container on port 4000

2. **Rust Daemon (`daemon/rust/component-daemon/src/main.rs`)**

   - High-performance component processor
   - Written in Rust using Warp and async-graphql
   - Subscribes to registry updates
   - Routes components to renderers
   - Runs in Docker container on port 3001

3. **Node Daemon (`daemon/simple-daemon.js`)**

   - Alternative daemon implementation in Node.js
   - Same functionality as Rust daemon
   - Demonstrates technology flexibility
   - Runs in Docker container on port 3002

4. **React Renderer (`renderer/frontend`)**

   - Dynamic component rendering
   - Real-time updates via WebSocket
   - Modern UI with animations
   - Runs in Docker container on port 3000

5. **HTML Renderer (`renderer/html`)**
   - Static HTML rendering alternative
   - Lightweight deployment option
   - Basic component display
   - Runs in Docker container on port 8081

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

- Run `make logs` and check registry output
- Verify registry service is up with `docker-compose ps`
- If needed, restart registry:
  ```bash
  docker-compose stop registry
  make up  # Restarts registry
  ```

**Daemon not receiving components:**

- Verify WebSocket connection to registry
- Check GraphQL subscription query syntax
- Look for connection errors in daemon logs

**Frontend not showing components:**

- Confirm WebSocket connection to daemon
- Check browser console for connection errors
- Verify component renderer types match incoming data

### Debug Commands

**Service Management:**

```bash
# Stop all services
make down

# Rebuild and restart all services
make build && make all

# View logs for all services
make logs

# Interactive service selection
make stack
```

**Health Checks:**

```bash
# Registry health
curl http://localhost:4000/

# Daemon health
curl http://localhost:3001/

# Test Registry GraphQL
curl -X POST http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "query { components { id type } }"}'
```

### Log Analysis

**View All Logs:**

```bash
# View all service logs
make logs

# View logs for specific service
docker-compose logs registry
docker-compose logs rust-daemon
docker-compose logs react-renderer
```

**Common Log Messages:**

**Registry Logs (`make logs registry`):**

- `📦 Registry: Publishing component` - Component created
- `📡 Registry: New daemon subscription connected` - Daemon connected

**Daemon Logs (`make logs rust-daemon` or `make logs node-daemon`):**

- `📦 Daemon: Received component from registry` - Component received
- `📦 Daemon: Forwarding component to renderer` - Component forwarded

**Frontend Logs (`make logs react-renderer` or `make logs html-renderer`):**

- `📦 Renderer: Received component from daemon` - Component received
- `✅ Renderer: Connected to daemon` - Connection established

**Interactive Stack Management:**

```bash
# Start services interactively
make stack

# This allows you to:
# 1. Choose your daemon (Rust or Node.js)
# 2. Choose your renderer (React or HTML)
# 3. View logs for selected components
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Build and test:

   ```bash
   # Build all services
   make build

   # Start stack interactively
   make stack

   # Run tests (after selecting components)
   curl -X POST http://localhost:4000/render \
     -H "Content-Type: application/json" \
     -d '{"type":"NOTIFICATION","data":{"type":"SUCCESS","title":"Test","message":"Test"}}'
   ```

5. Submit a pull request

## � Development Workflow

### Local Development

1. **Start Base Services:**

   ```bash
   # Start registry only
   make up
   ```

2. **Choose Your Stack:**

   ```bash
   # Interactive component selection
   make stack
   ```

3. **Development Loop:**

   ```bash
   # Rebuild specific service
   docker-compose build rust-daemon

   # Restart service
   make rust-daemon

   # View logs
   make logs
   ```

### Common Development Tasks

1. **Switch Daemons:**

   ```bash
   # Stop current daemon
   docker-compose stop rust-daemon

   # Start alternative
   make node-daemon
   ```

2. **Change Renderers:**

   ```bash
   # Stop current renderer
   docker-compose stop react-renderer

   # Start alternative
   make html-renderer
   ```

3. **Full System Restart:**

   ```bash
   # Stop all services
   make down

   # Rebuild and restart
   make build
   make all
   ```

## �📄 License

MIT License - see LICENSE file for details.

---
