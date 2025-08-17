use std::convert::Infallible;
use std::time::Duration;
use std::sync::Arc;

use anyhow::{Context, Result};
use async_graphql::*;
use async_stream::stream;
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt, stream::SplitSink};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio::time::sleep;
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};
use tracing::{error, info, warn};
use warp::Filter;
use uuid::Uuid;
use futures_util::Stream;

// ========================
// GRAPHQL SCHEMA
// ========================

struct Query;

#[Object]
impl Query {
    async fn health(&self) -> bool {
        true
    }
}

struct Mutation;

#[Object]
impl Mutation {
    async fn send_message(&self, ctx: &async_graphql::Context<'_>, message: String) -> Result<bool> {
        let daemon = ctx.data_unchecked::<ComponentDaemon>();
        let msg: DaemonMessage = serde_json::from_str(&message)?;
        daemon.handle_message(msg).await?;
        Ok(true)
    }
}

struct Subscription;

#[Subscription]
impl Subscription {
    async fn messages(&self, ctx: &async_graphql::Context<'_>) -> impl Stream<Item = DaemonMessage> {
        let daemon = ctx.data_unchecked::<ComponentDaemon>();
        daemon.subscribe().await
    }
}

// ========================
// TYPES
// ========================

#[derive(Clone, Debug, Serialize, Deserialize, SimpleObject)]
#[serde(rename_all = "camelCase")]
pub struct DaemonMessage {
    pub direction: MessageDirection,
    pub payload: serde_json::Value,
    pub metadata: Option<MessageMetadata>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Enum, Copy, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MessageDirection {
    Component,
    Action,
}

#[derive(Clone, Debug, Serialize, Deserialize, SimpleObject)]
#[serde(rename_all = "camelCase")]
pub struct MessageMetadata {
    pub acknowledged: bool,
    pub correlation_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, SimpleObject)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: String,
    pub r#type: ComponentType,
    pub data: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, SimpleObject)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub id: String,
    pub component_id: String,
    pub action_type: String,
    pub data: serde_json::Value,
    pub timestamp: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Enum, Copy, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ComponentType {
    Card,
    Notification,
    Form,
}

// ========================
// STATE MANAGEMENT
// ========================

#[derive(Clone, Debug, Serialize)]
pub struct ComponentState {
    pub component: Component,
    pub actions: Vec<Action>,
    pub last_updated: DateTime<Utc>,
}

// ========================
// DAEMON
// ========================

#[derive(Clone)]
pub struct ComponentDaemon {
    components: Arc<DashMap<String, ComponentState>>,
    all_components: Arc<tokio::sync::Mutex<Vec<Component>>>,
    broadcast_tx: broadcast::Sender<DaemonMessage>,
}

impl ComponentDaemon {
    pub fn new() -> Self {
        let (broadcast_tx, _) = broadcast::channel(100);
        Self {
            components: Arc::new(DashMap::new()),
            all_components: Arc::new(tokio::sync::Mutex::new(Vec::new())),
            broadcast_tx,
        }
    }

    /// Gets the raw components map with states
    pub fn get_component_states_map(&self) -> Arc<DashMap<String, ComponentState>> {
        self.components.clone()
    }

    /// Gets a list of all components currently in the daemon.
    /// This returns the components themselves, without their associated actions and state.
    pub fn get_components(&self) -> Vec<Component> {
        self.components.iter()
            .map(|entry| entry.value().component.clone())
            .collect()
    }
    
    /// Gets a list of all component states, including components and their actions
    pub fn get_component_states(&self) -> Vec<ComponentState> {
        self.components.iter()
            .map(|entry| entry.value().clone())
            .collect()
    }

    pub async fn get_all_components_count(&self) -> usize {
        self.all_components.lock().await.len()
    }

    pub async fn handle_message(&self, message: DaemonMessage) -> Result<Option<DaemonMessage>> {
        match message.direction {
            MessageDirection::Action => {
                info!("[Daemon] Received ACTION message: {:?}", message);
                self.handle_action(message).await
            },
            MessageDirection::Component => {
                info!("[Daemon] Received COMPONENT message: {:?}", message);
                self.handle_component(message).await
            },
        }
    }

    async fn handle_action(&self, message: DaemonMessage) -> Result<Option<DaemonMessage>> {
        let action: Action = serde_json::from_value(message.payload.clone())?;
        info!("[Daemon] Storing action for component {}: {:?}", action.component_id, action);
        // Update component state
        if let Some(mut state) = self.components.get_mut(&action.component_id) {
            state.actions.push(action.clone());
            state.last_updated = Utc::now();
            info!("[Daemon] Updated state for component {}: now has {} actions", action.component_id, state.actions.len());
            // Send state update to registry
            let state_message = DaemonMessage {
                direction: MessageDirection::Component,
                payload: serde_json::to_value(&*state)?,
                metadata: Some(MessageMetadata {
                    acknowledged: false,
                    correlation_id: Some(Uuid::new_v4().to_string()),
                    error: None,
                }),
            };
            let _ = self.broadcast_tx.send(state_message.clone());

            // --- NEW: Send handleMessage mutation over WebSocket to registry ---
            // This is a fire-and-forget; errors are logged but do not block
            let registry_host = std::env::var("REGISTRY_HOST").unwrap_or_else(|_| "registry".to_string());
            let registry_port = std::env::var("REGISTRY_PORT").unwrap_or_else(|_| "4000".to_string());
            let url = format!("ws://{registry_host}:{registry_port}/graphql");
            let message_json = serde_json::to_string(&message).unwrap_or_default();
            let mutation = "mutation handleMessage($message: String!) { handleMessage(message: $message) }".to_string();
            let payload = serde_json::json!({
                "id": format!("mutation-{}", Uuid::new_v4()),
                "type": "subscribe",
                "payload": {
                    "query": mutation,
                    "variables": { "message": message_json }
                }
            });
            // Spawn a task to send the mutation over WebSocket
            tokio::spawn(async move {
                use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};
                // Build request with correct subprotocol
                let mut request = match url.clone().into_client_request() {
                    Ok(r) => r,
                    Err(e) => { tracing::error!("[Daemon] Mutation WS build request error: {}", e); return; }
                };
                if let Ok(hdr_val) = "graphql-transport-ws".parse() { request.headers_mut().append("Sec-WebSocket-Protocol", hdr_val); }
                match connect_async(request).await {
                    Ok((mut ws, _)) => {
                        tracing::info!("[Daemon] Mutation WS connected for handleMessage");
                        // Send connection_init
                        let _ = ws.send(WsMessage::Text(serde_json::json!({"type": "connection_init"}).to_string())).await;
                        tracing::info!("[Daemon] Mutation WS sent connection_init, awaiting connection_ack before sending mutation");

                        // Wait for connection_ack before sending mutation (spec requirement)
                        let mut acked = false;
                        let start_wait = std::time::Instant::now();
                        while start_wait.elapsed() < Duration::from_secs(2) {
                            match tokio::time::timeout(Duration::from_millis(400), ws.next()).await {
                                Ok(Some(Ok(evt))) => match evt {
                                    WsMessage::Text(txt) => {
                                        tracing::info!("[Daemon] Mutation WS pre-ack received: {}", txt);
                                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&txt) {
                                            if val.get("type").and_then(|v| v.as_str()) == Some("connection_ack") {
                                                acked = true;
                                                break;
                                            }
                                            // respond to ping if any before ack
                                            if val.get("type").and_then(|v| v.as_str()) == Some("ping") {
                                                let _ = ws.send(WsMessage::Text(serde_json::json!({"type":"pong"}).to_string())).await;
                                            }
                                        }
                                    }
                                    WsMessage::Ping(d) => { let _ = ws.send(WsMessage::Pong(d)).await; }
                                    WsMessage::Close(cf) => { tracing::warn!("[Daemon] Mutation WS closed before ack: {:?}", cf); break; }
                                    WsMessage::Pong(_) => {}
                                    other => { tracing::info!("[Daemon] Mutation WS other pre-ack frame: {:?}", other); }
                                },
                                Ok(Some(Err(e))) => { tracing::error!("[Daemon] Mutation WS error waiting for ack: {}", e); break; }
                                Ok(None) => { break; }
                                Err(_) => { /* per-iteration timeout */ }
                            }
                        }
                        if !acked {
                            tracing::error!("[Daemon] Mutation WS did not receive connection_ack in time; aborting mutation send");
                            let _ = ws.close(None).await;
                            return;
                        }

                        // Send mutation after ack
                        tracing::info!("[Daemon] Sending handleMessage mutation over WS (after ack): {}", payload);
                        if let Err(e) = ws.send(WsMessage::Text(payload.to_string())).await { tracing::error!("[Daemon] Failed to send mutation subscribe: {}", e); }

                        // Wait for next/complete or timeout
                        let mut done = false;
                        let start = std::time::Instant::now();
                        while start.elapsed() < Duration::from_secs(3) {
                            match tokio::time::timeout(Duration::from_millis(400), ws.next()).await {
                                Ok(Some(Ok(evt))) => {
                                    match evt {
                                        WsMessage::Text(txt) => {
                                            tracing::info!("[Daemon] Mutation WS received: {}", txt);
                                            if txt.contains("\"type\":\"complete\"") || txt.contains("\"complete\"") { done = true; break; }
                                        }
                                        WsMessage::Close(cf) => { tracing::info!("[Daemon] Mutation WS close frame: {:?}", cf); break; }
                                        WsMessage::Ping(d) => { let _ = ws.send(WsMessage::Pong(d)).await; }
                                        WsMessage::Pong(_) => {}
                                        other => { tracing::info!("[Daemon] Mutation WS other frame: {:?}", other); }
                                    }
                                }
                                Ok(Some(Err(e))) => { tracing::error!("[Daemon] Mutation WS error: {}", e); break; }
                                Ok(None) => { break; }
                                Err(_) => { /* per-iteration timeout */ }
                            }
                        }
                        if !done { tracing::info!("[Daemon] Mutation WS closing (timeout or no complete)"); }
                        let _ = ws.close(None).await;
                    }
                    Err(e) => {
                        tracing::error!("[Daemon] Failed to connect to registry WebSocket for mutation: {}", e);
                    }
                }
            });
            // --- END NEW ---

            Ok(Some(state_message))
        } else {
            warn!("[Daemon] Tried to store action for unknown component: {}", action.component_id);
            Ok(None)
        }
    }

    async fn handle_component(&self, message: DaemonMessage) -> Result<Option<DaemonMessage>> {
        let component: Component = serde_json::from_value(message.payload.clone())?;
        info!("[Daemon] Storing/Updating component: {}", component.id);
        // Create or update component state
        let state = ComponentState {
            component: component.clone(),
            actions: Vec::new(),
            last_updated: Utc::now(),
        };
        self.components.insert(component.id.clone(), state);
        info!("[Daemon] Component {} stored/updated", component.id);
        // Forward to renderers
        let forward_message = DaemonMessage {
            direction: MessageDirection::Component,
            payload: message.payload,
            metadata: Some(MessageMetadata {
                acknowledged: false,
                correlation_id: Some(Uuid::new_v4().to_string()),
                error: None,
            }),
        };
        let _ = self.broadcast_tx.send(forward_message.clone());
        Ok(Some(forward_message))
    }

    pub async fn subscribe(&self) -> impl Stream<Item = DaemonMessage> {
        let mut rx = self.broadcast_tx.subscribe();
        stream! {
            while let Ok(msg) = rx.recv().await {
                yield msg;
            }
        }
    }

    pub async fn connect_to_registry(&self) {
        loop {
            info!("🔌 Daemon: Connecting to registry...");

            match self.try_connect_to_registry().await {
                Ok(_) => {
                    warn!("🔌 Daemon: Connection to registry closed, reconnecting...");
                }
                Err(e) => {
                    error!("❌ Daemon: Registry connection error: {}", e);
                }
            }

            sleep(Duration::from_secs(2)).await;
        }
    }

    pub async fn start(&self) -> Result<()> {
        let daemon = self.clone();
        tokio::spawn(async move {
            daemon.connect_to_registry().await;
        });
        info!("🚀 Daemon: Started");
        Ok(())
    }

    async fn try_connect_to_registry(&self) -> Result<()> {
        let registry_host = std::env::var("REGISTRY_HOST").unwrap_or_else(|_| "registry".to_string());
        let registry_port = std::env::var("REGISTRY_PORT").unwrap_or_else(|_| "4000".to_string());
        let url = format!("ws://{registry_host}:{registry_port}/graphql");
        info!("🔌 Daemon: Attempting to connect to {}", url);
        use tokio_tungstenite::tungstenite;
        let host_header = format!("{registry_host}:{registry_port}");
        const SUBPROTOCOL: &str = "graphql-transport-ws";

        async fn connect_with_protocol(url: &str, host: &str) -> Result<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>> {
            let request = tungstenite::http::Request::builder()
                .uri(url)
                .header("Host", host)
                .header("Connection", "Upgrade")
                .header("Upgrade", "websocket")
                .header("Sec-WebSocket-Version", "13")
                .header("Sec-WebSocket-Key", tungstenite::handshake::client::generate_key())
                .header("Sec-WebSocket-Protocol", SUBPROTOCOL)
                .body(())?;
            let (ws_stream, response) = connect_async(request).await?;
            info!("✅ Daemon: Connected (status {}) with subprotocol {}", response.status(), SUBPROTOCOL);
            Ok(ws_stream)
        }

        let ws_stream = connect_with_protocol(&url, &host_header).await?;
        let (mut write, mut read) = ws_stream.split();

        // Send connection_init (empty payload acceptable)
        let init = serde_json::json!({"type": "connection_init"});
        let init_txt = serde_json::to_string(&init)?;
        info!("📤 Daemon: Sending connection_init");
        write.send(WsMessage::Text(init_txt)).await?;

        let mut acknowledged = false;

        while let Some(msg) = read.next().await {
            match msg {
                Ok(WsMessage::Text(text)) => {
                    let message: serde_json::Value = match serde_json::from_str(&text) { Ok(v) => v, Err(e) => { error!("❌ Daemon: Invalid JSON: {}", e); continue; } };
                    let msg_type = message.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match msg_type {
                        "connection_ack" => {
                            info!("📡 Daemon: Received connection_ack");
                            if !acknowledged {
                                acknowledged = true;
                                // Now send subscription
                                let subscribe_msg = serde_json::json!({
                                    "id": "registry-sub",
                                    "type": "subscribe",
                                    "payload": { "query": "subscription { componentUpdate { id type data createdAt } }" }
                                });
                                write.send(WsMessage::Text(subscribe_msg.to_string())).await?;
                                info!("📡 Daemon: Sent subscribe");
                            }
                        }
                        "next" => {
                            if let Some(payload) = message.get("payload") { if let Some(data) = payload.get("data") { if let Some(component_update) = data.get("componentUpdate") { match serde_json::from_value::<Component>(component_update.clone()) { Ok(c) => { self.handle_component_from_registry(c).await?; }, Err(e) => error!("❌ Daemon: Deserialize component error: {}", e) } } } }
                        }
                        "error" => { error!("❌ Daemon: GraphQL error: {}", message); }
                        "complete" => { info!("✅ Daemon: Subscription complete from server"); }
                        "ping" => { let pong = serde_json::json!({"type": "pong"}); write.send(WsMessage::Text(pong.to_string())).await?; }
                        "pong" => { /* ignore */ }
                        other => { info!("ℹ️ Daemon: Unhandled message type '{}': {}", other, text); }
                    }
                }
                Ok(WsMessage::Ping(data)) => { write.send(WsMessage::Pong(data)).await?; }
                Ok(WsMessage::Pong(_)) => {}
                Ok(WsMessage::Close(frame)) => { if let Some(f) = frame { warn!("🔌 Daemon: Server closed: code={:?} reason='{}'", f.code, f.reason); } break; }
                Err(e) => { error!("❌ Daemon: WebSocket error: {}", e); break; }
                _ => {}
            }
        }
        Err(anyhow::anyhow!("Connection loop ended"))
    }

    async fn handle_registry_message(
        &self,
        write: &mut SplitSink<
            tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
            WsMessage,
        >,
        text: &str,
    ) -> Result<()> {
        // Parse as generic JSON first to see the message type
        let message: serde_json::Value = serde_json::from_str(text)
            .context("Failed to parse message from registry")?;

        let msg_type = message.get("type").and_then(|v| v.as_str()).unwrap_or("unknown");
        info!("📨 Daemon: Received message type: {}", msg_type);

        match msg_type {
            "connection_ack" => {
                info!("📡 Daemon: Registry connection acknowledged, sending subscribe...");
                let subscription = serde_json::json!({
                    "id": "registry-sub",
                    "type": "subscribe",
                    "payload": { "query": "subscription { componentUpdate { id type data createdAt } }" }
                });
                let sub_json = serde_json::to_string(&subscription)?;
                info!("📡 Daemon: Sending subscribe: {}", sub_json);
                write.send(WsMessage::Text(sub_json)).await?;
            }
            "next" => { // data payload for a subscription event
                if let Some(payload) = message.get("payload") {
                    if let Some(data) = payload.get("data") {
                        if let Some(component_update) = data.get("componentUpdate") {
                            match serde_json::from_value::<Component>(component_update.clone()) {
                                Ok(component) => {
                                    info!("📦 Daemon: Received component from registry: {}", component.id);
                                    self.handle_component_from_registry(component).await?;
                                },
                                Err(e) => { error!("❌ Daemon: Failed to deserialize component: {}\nValue: {}", e, component_update); }
                            }
                        }
                    }
                }
            }
            "error" => {
                if let Some(payload) = message.get("payload") { error!("❌ Daemon: GraphQL error from registry: {}", payload); }
            }
            "complete" => { info!("✅ Daemon: Subscription completed"); }
            "ping" => { // respond with pong per protocol
                info!("💓 Daemon: Received ping, replying pong");
                let pong = serde_json::json!({"type": "pong"});
                write.send(WsMessage::Text(serde_json::to_string(&pong)?)).await?;
            }
            "pong" => { info!("💓 Daemon: Received pong"); }
            _ => { info!("ℹ️ Daemon: Unknown message type '{}'", msg_type); }
        }
        Ok(())
    }

    async fn handle_component_from_registry(&self, component: Component) -> Result<()> {
        info!("📦 Daemon: Forwarding component {} to renderer", component.id);
        let state = ComponentState {
            component: component.clone(),
            actions: Vec::new(),
            last_updated: Utc::now(),
        };
        self.components.insert(component.id.clone(), state);

        // Store for history
        {
            let mut all = self.all_components.lock().await;
            all.push(component.clone());
            info!("📦 Daemon: Total components so far: {}", all.len());
        }
        
        // Create message for broadcasting
        let message = DaemonMessage {
            direction: MessageDirection::Component,
            payload: serde_json::to_value(component)?,
            metadata: Some(MessageMetadata {
                acknowledged: false,
                correlation_id: Some(Uuid::new_v4().to_string()),
                error: None,
            }),
        };
        
        let _ = self.broadcast_tx.send(message);
        Ok(())
    }
}

// ========================
// SERVER
// ========================

pub async fn start_daemon(port: u16) -> Result<()> {
    let daemon = ComponentDaemon::new();
    // Start the daemon to initiate the registry connection
    let daemon_for_start = daemon.clone();
    tokio::spawn(async move {
        daemon_for_start.connect_to_registry().await;
    });

    // Create GraphQL schema
    let schema = Schema::build(Query, Mutation, Subscription)
        .data(daemon.clone())
        .finish();

    // Health check endpoint
    let daemon_for_health = daemon.clone();
    let health = warp::path::end()
        .and_then(move || {
            let daemon_for_health = daemon_for_health.clone();
            async move {
                let components_count = daemon_for_health.get_all_components_count().await;
                Ok::<_, Infallible>(warp::reply::json(&serde_json::json!({
                    "message": "Component Daemon - Real Connection",
                    "components": components_count,
                    "status": "Connected to registry"
                })))
            }
        });

    // GraphQL Playground (for browser testing)
    let graphql_playground = warp::path("playground")
        .and(warp::get())
        .map(|| {
            warp::reply::html(async_graphql::http::playground_source(
                async_graphql::http::GraphQLPlaygroundConfig::new("/graphql")
            ))
        });

    // GraphQL endpoint for queries and mutations  
    let graphql_post = warp::path("graphql")
        .and(async_graphql_warp::graphql(schema.clone()))
        .and_then(
            |(schema, request): (
                async_graphql::Schema<Query, Mutation, Subscription>,
                async_graphql::Request,
            )| async move {
                Ok::<_, Infallible>(async_graphql_warp::GraphQLResponse::from(schema.execute(request).await))
            },
        );

    let graphql_ws = async_graphql_warp::graphql_subscription(schema.clone());



    let routes = health
        .or(graphql_playground)
        .or(graphql_post.or(graphql_ws))
        .with(
            warp::cors()
                .allow_any_origin()
                .allow_headers(vec!["content-type"])
                .allow_methods(vec!["GET", "POST"])
        );

    info!("🚀 Component Daemon running on http://0.0.0.0:{}", port);
    info!("📡 GraphQL: http://0.0.0.0:{}/graphql", port);
    info!("🎮 Playground: http://0.0.0.0:{}/playground", port);

    warp::serve(routes)
        .run(([0, 0, 0, 0], port))
        .await;

    Ok(())
}

// ========================
// MAIN
// ========================

#[tokio::main]
async fn main() -> Result<()> {
    // Set up tracing first
    tracing_subscriber::fmt()
        .with_file(true)
        .with_line_number(true)
        .with_target(false)
        .with_env_filter("info")
        .init();

    // Start the daemon on port 3001 by default
    let port = std::env::var("DAEMON_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(3001);

    start_daemon(port).await
}