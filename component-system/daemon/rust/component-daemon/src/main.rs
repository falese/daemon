// ========================
// COMPONENT DAEMON (Rust)
// ========================
// Role in the system:
//   - Connects to the Registry via a persistent GraphQL-WS subscription
//   - Exposes a GraphQL-WS server so renderers can subscribe to live updates
//   - Receives actions from renderers, acknowledges them, and forwards them to
//     the Registry where rule evaluation happens
//
// This is the Rust implementation of the same daemon contract as simple-daemon.js.
// It uses async_graphql + warp for the server and tokio_tungstenite for WS clients.

use std::convert::Infallible;
use std::time::Duration;
use std::sync::Arc;

use anyhow::Result;
use async_graphql::*;
use async_stream::stream;
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio::time::sleep;
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};
use tracing::{error, info, warn};
use uuid::Uuid;
use futures_util::Stream;
use warp::Filter;

// ── Constants ─────────────────────────────────────────────────────────────────

/// How long to wait for connection_ack before aborting a forwarded mutation.
const REGISTRY_ACK_TIMEOUT_SECS: u64 = 2;

/// Overall timeout for a forwarded mutation (connection + ack + result).
const MUTATION_TIMEOUT_SECS: u64 = 3;

/// How long to wait between registry reconnect attempts.
const RECONNECT_DELAY_SECS: u64 = 2;

const GRAPHQL_SUBPROTOCOL: &str = "graphql-transport-ws";

// ========================
// GRAPHQL SCHEMA
// ========================

struct Query;

#[Object]
impl Query {
    async fn health(&self) -> bool { true }
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

#[derive(Clone, Debug, Serialize, Deserialize, Enum, Copy, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MessageKind {
    ComponentUpdate,
    StateSnapshot,
    ActionEcho,
}

#[derive(Clone, Debug, Serialize, Deserialize, SimpleObject)]
#[serde(rename_all = "camelCase")]
pub struct DaemonMessage {
    pub direction: MessageDirection,
    #[serde(default)]
    pub kind: Option<MessageKind>,
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
// STATE
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

/// The central daemon struct. Clone-safe — all fields are wrapped in Arc.
#[derive(Clone)]
pub struct ComponentDaemon {
    /// Component state store: id -> { component, actions, last_updated }
    /// DashMap gives us concurrent reads without locking.
    components: Arc<DashMap<String, ComponentState>>,

    /// Broadcast channel to fan out messages to all connected renderer subscriptions.
    broadcast_tx: broadcast::Sender<DaemonMessage>,
}

impl ComponentDaemon {
    pub fn new() -> Self {
        let (broadcast_tx, _) = broadcast::channel(100);
        Self {
            components: Arc::new(DashMap::new()),
            broadcast_tx,
        }
    }

    pub fn get_components(&self) -> Vec<Component> {
        self.components.iter().map(|e| e.value().component.clone()).collect()
    }

    pub fn get_component_states(&self) -> Vec<ComponentState> {
        self.components.iter().map(|e| e.value().clone()).collect()
    }

    // ── Message dispatch ───────────────────────────────────────────────────────

    pub async fn handle_message(&self, message: DaemonMessage) -> Result<Option<DaemonMessage>> {
        match message.direction {
            MessageDirection::Action    => self.handle_action(message).await,
            MessageDirection::Component => self.handle_component(message).await,
        }
    }

    // ── Action handling ────────────────────────────────────────────────────────
    // 1. Normalise action type (BUTTON_CLICK → CLICK)
    // 2. Record action in local state
    // 3. Broadcast ACTION_ECHO to renderers
    // 4. Broadcast STATE_SNAPSHOT to renderers
    // 5. Forward to Registry via fire-and-forget mutation (see forward_action_to_registry)

    async fn handle_action(&self, message: DaemonMessage) -> Result<Option<DaemonMessage>> {
        let mut action: Action = serde_json::from_value(message.payload.clone())?;

        // Step 1: Normalise — retain original type in data payload
        if action.action_type == "BUTTON_CLICK" {
            info!("DAE-224 ACTION_NORMALIZED — BUTTON_CLICK -> CLICK for action={}", action.id);
            if let Some(obj) = action.data.as_object_mut() {
                obj.insert("_originalActionType".to_string(), serde_json::Value::String("BUTTON_CLICK".into()));
            }
            action.action_type = "CLICK".into();
        }

        info!("DAE-220 ACTION_RECEIVED — id={} componentId={} actionType={}", action.id, action.component_id, action.action_type);

        // Step 2: Record in local state (if the component is known)
        let state_snapshot = if let Some(mut state) = self.components.get_mut(&action.component_id) {
            state.actions.push(action.clone());
            state.last_updated = Utc::now();
            Some(state.clone())
        } else {
            warn!("DAE-221 ACTION_NO_STATE — no component state for id={}; action will be forwarded but local state not updated", action.component_id);
            None
        };

        // Step 3: Echo — immediate acknowledgement to renderer
        let echo = DaemonMessage {
            direction: MessageDirection::Action,
            kind: Some(MessageKind::ActionEcho),
            payload: serde_json::to_value(&action)?,
            metadata: Some(MessageMetadata {
                acknowledged: true,
                correlation_id: message.metadata.as_ref()
                    .and_then(|m| m.correlation_id.clone())
                    .or_else(|| Some(Uuid::new_v4().to_string())),
                error: None,
            }),
        };
        let _ = self.broadcast_tx.send(echo.clone());
        info!("DAE-222 ACTION_ECHO_SENT — id={}", action.id);

        // Step 4: Snapshot — send current component state to renderer
        if let Some(state) = &state_snapshot {
            let snapshot = DaemonMessage {
                direction: MessageDirection::Component,
                kind: Some(MessageKind::StateSnapshot),
                payload: serde_json::to_value(state)?,
                metadata: Some(MessageMetadata {
                    acknowledged: false,
                    correlation_id: Some(Uuid::new_v4().to_string()),
                    error: None,
                }),
            };
            let _ = self.broadcast_tx.send(snapshot);
        }

        // Step 5: Forward to Registry (fire-and-forget — errors are logged, not propagated)
        info!("DAE-230 ACTION_FORWARD_START — id={}", action.id);
        let daemon = self.clone();
        let action_id = action.id.clone();
        tokio::spawn(async move {
            if let Err(e) = daemon.forward_action_to_registry(message).await {
                error!("DAE-299 ACTION_FORWARD_ERROR — id={} err={}", action_id, e);
            }
        });

        Ok(Some(echo))
    }

    // ── Forward action to Registry ─────────────────────────────────────────────
    // Opens a short-lived WebSocket connection to the Registry, sends the
    // handleMessage mutation, and closes. A new connection per action is simpler
    // and avoids ID-collision issues with the persistent subscription socket.

    async fn forward_action_to_registry(&self, message: DaemonMessage) -> Result<()> {
        let registry_host = std::env::var("REGISTRY_HOST").unwrap_or_else(|_| "registry".to_string());
        let registry_port = std::env::var("REGISTRY_PORT").unwrap_or_else(|_| "4000".to_string());
        let url = std::env::var("REGISTRY_WS_URL")
            .unwrap_or_else(|_| format!("ws://{registry_host}:{registry_port}/graphql"));

        let op_id = format!("fwd-{}", Uuid::new_v4());
        let message_json = serde_json::to_string(&message)?;

        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut request = url.into_client_request()?;
        if let Ok(hdr) = GRAPHQL_SUBPROTOCOL.parse() {
            request.headers_mut().append("Sec-WebSocket-Protocol", hdr);
        }

        let (mut ws, _) = connect_async(request).await?;
        info!("DAE-231 ACTION_FORWARD_WS_OPEN — opId={}", op_id);

        // Send connection_init
        ws.send(WsMessage::Text(r#"{"type":"connection_init"}"#.to_string())).await?;

        // Wait for connection_ack before sending mutation
        let ack_deadline = Duration::from_secs(REGISTRY_ACK_TIMEOUT_SECS);
        let acked = wait_for_ack(&mut ws, ack_deadline).await;
        if !acked {
            error!("DAE-299 ACTION_FORWARD_NO_ACK — opId={} — registry did not ack in time", op_id);
            let _ = ws.close(None).await;
            return Ok(());
        }

        // Send the mutation
        let payload = serde_json::json!({
            "id": op_id,
            "type": "subscribe",
            "payload": {
                "query": "mutation handleMessage($message: String!) { handleMessage(message: $message) }",
                "variables": { "message": message_json }
            }
        });
        ws.send(WsMessage::Text(payload.to_string())).await?;
        info!("DAE-231 ACTION_FORWARD_MUTATION_SENT — opId={}", op_id);

        // Wait for next/complete or timeout
        let result_deadline = Duration::from_secs(MUTATION_TIMEOUT_SECS);
        let start = std::time::Instant::now();
        while start.elapsed() < result_deadline {
            match tokio::time::timeout(Duration::from_millis(400), ws.next()).await {
                Ok(Some(Ok(WsMessage::Text(txt)))) => {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&txt) {
                        match val.get("type").and_then(|v| v.as_str()) {
                            Some("next")     => { info!("DAE-232 ACTION_FORWARD_RESULT — opId={}", op_id); }
                            Some("complete") => { info!("DAE-232 ACTION_FORWARD_COMPLETE — opId={}", op_id); break; }
                            Some("error")    => { error!("DAE-299 ACTION_FORWARD_GQL_ERROR — opId={} payload={}", op_id, txt); break; }
                            Some("ping")     => { let _ = ws.send(WsMessage::Text(r#"{"type":"pong"}"#.to_string())).await; }
                            _ => {}
                        }
                    }
                }
                Ok(Some(Ok(WsMessage::Ping(d)))) => { let _ = ws.send(WsMessage::Pong(d)).await; }
                Ok(Some(Ok(WsMessage::Close(_)))) => break,
                Ok(Some(Err(e))) => { error!("DAE-299 ACTION_FORWARD_WS_ERROR — {}", e); break; }
                Ok(None) => break,
                Err(_)   => { /* per-iteration timeout, keep looping */ }
                _ => {}
            }
        }

        let _ = ws.close(None).await;
        info!("DAE-232 ACTION_FORWARD_WS_CLOSE — opId={}", op_id);
        Ok(())
    }

    // ── Component handling ─────────────────────────────────────────────────────

    async fn handle_component(&self, message: DaemonMessage) -> Result<Option<DaemonMessage>> {
        let component: Component = serde_json::from_value(message.payload.clone())?;
        info!("DAE-210 COMPONENT_STORED — id={}", component.id);
        self.components.insert(component.id.clone(), ComponentState {
            component,
            actions: Vec::new(),
            last_updated: Utc::now(),
        });
        let forward = DaemonMessage {
            direction: MessageDirection::Component,
            kind: Some(MessageKind::ComponentUpdate),
            payload: message.payload,
            metadata: Some(MessageMetadata {
                acknowledged: false,
                correlation_id: Some(Uuid::new_v4().to_string()),
                error: None,
            }),
        };
        let _ = self.broadcast_tx.send(forward.clone());
        Ok(Some(forward))
    }

    /// Called when the registry subscription delivers a new component
    async fn handle_component_from_registry(&self, component: Component) -> Result<()> {
        info!("DAE-210 COMPONENT_FROM_REGISTRY — id={}", component.id);
        self.components.insert(component.id.clone(), ComponentState {
            component: component.clone(),
            actions: Vec::new(),
            last_updated: Utc::now(),
        });
        let message = DaemonMessage {
            direction: MessageDirection::Component,
            kind: Some(MessageKind::ComponentUpdate),
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

    // ── Renderer subscription ──────────────────────────────────────────────────

    pub async fn subscribe(&self) -> impl Stream<Item = DaemonMessage> {
        let mut rx = self.broadcast_tx.subscribe();
        stream! {
            while let Ok(msg) = rx.recv().await {
                yield msg;
            }
        }
    }

    // ── Registry connection (persistent subscription) ──────────────────────────
    // Loops forever: connect → subscribe → receive components → reconnect on drop.

    pub async fn connect_to_registry(&self) {
        loop {
            info!("DAE-201 WS_REGISTRY_CONNECT — attempting connection to registry");
            match self.try_connect_to_registry().await {
                Ok(_)  => warn!("DAE-240 WS_REGISTRY_CLOSED — connection dropped, will reconnect"),
                Err(e) => error!("DAE-299 WS_REGISTRY_ERROR — {}", e),
            }
            sleep(Duration::from_secs(RECONNECT_DELAY_SECS)).await;
        }
    }

    async fn try_connect_to_registry(&self) -> Result<()> {
        let registry_host = std::env::var("REGISTRY_HOST").unwrap_or_else(|_| "registry".to_string());
        let registry_port = std::env::var("REGISTRY_PORT").unwrap_or_else(|_| "4000".to_string());
        let url = std::env::var("REGISTRY_WS_URL")
            .unwrap_or_else(|_| format!("ws://{registry_host}:{registry_port}/graphql"));

        info!("DAE-201 WS_REGISTRY_CONNECT — url={}", url);

        use tokio_tungstenite::tungstenite;
        let request = tungstenite::http::Request::builder()
            .uri(&url)
            .header("Host", format!("{registry_host}:{registry_port}"))
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header("Sec-WebSocket-Key", tungstenite::handshake::client::generate_key())
            .header("Sec-WebSocket-Protocol", GRAPHQL_SUBPROTOCOL)
            .body(())?;

        let (ws_stream, _) = connect_async(request).await?;
        info!("DAE-202 WS_REGISTRY_OPEN — connected");

        let (mut write, mut read) = ws_stream.split();
        write.send(WsMessage::Text(r#"{"type":"connection_init"}"#.to_string())).await?;

        let mut subscribed = false;

        while let Some(msg) = read.next().await {
            match msg {
                Ok(WsMessage::Text(text)) => {
                    let value: serde_json::Value = match serde_json::from_str(&text) {
                        Ok(v)  => v,
                        Err(e) => { error!("DAE-299 WS_PARSE_ERROR — {}", e); continue; }
                    };
                    match value.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                        "connection_ack" if !subscribed => {
                            info!("DAE-202 WS_REGISTRY_ACK — sending componentUpdate subscription");
                            subscribed = true;
                            write.send(WsMessage::Text(serde_json::json!({
                                "id": "registry-sub",
                                "type": "subscribe",
                                "payload": { "query": "subscription { componentUpdate { id type data createdAt } }" }
                            }).to_string())).await?;
                        }
                        "next" => {
                            if let Some(comp) = value
                                .get("payload")
                                .and_then(|p| p.get("data"))
                                .and_then(|d| d.get("componentUpdate"))
                            {
                                match serde_json::from_value::<Component>(comp.clone()) {
                                    Ok(c)  => self.handle_component_from_registry(c).await?,
                                    Err(e) => error!("DAE-299 COMPONENT_DESERIALIZE_ERROR — {}", e),
                                }
                            }
                        }
                        "error"    => error!("DAE-299 WS_REGISTRY_GQL_ERROR — {}", text),
                        "complete" => info!("DAE-240 WS_REGISTRY_COMPLETE — subscription ended by server"),
                        "ping"     => {
                            write.send(WsMessage::Text(r#"{"type":"pong"}"#.to_string())).await?;
                        }
                        _          => { /* pong and other frames — no action needed */ }
                    }
                }
                Ok(WsMessage::Ping(d)) => { write.send(WsMessage::Pong(d)).await?; }
                Ok(WsMessage::Pong(_)) => {}
                Ok(WsMessage::Close(f)) => {
                    if let Some(f) = f { warn!("DAE-240 WS_REGISTRY_CLOSE — code={:?} reason='{}'", f.code, f.reason); }
                    break;
                }
                Err(e) => { error!("DAE-299 WS_REGISTRY_ERROR — {}", e); break; }
                _ => {}
            }
        }

        Err(anyhow::anyhow!("Registry connection loop ended"))
    }
}

// ── Helper: wait for connection_ack ───────────────────────────────────────────

async fn wait_for_ack(
    ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    timeout: Duration,
) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        match tokio::time::timeout(Duration::from_millis(200), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(txt)))) => {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&txt) {
                    match val.get("type").and_then(|v| v.as_str()) {
                        Some("connection_ack") => return true,
                        Some("ping") => {
                            let _ = ws.send(WsMessage::Text(r#"{"type":"pong"}"#.to_string())).await;
                        }
                        _ => {}
                    }
                }
            }
            Ok(Some(Ok(WsMessage::Ping(d)))) => { let _ = ws.send(WsMessage::Pong(d)).await; }
            Ok(Some(Ok(WsMessage::Close(_)))) => return false,
            Ok(Some(Err(_))) | Ok(None) => return false,
            Err(_) => { /* poll timeout — keep waiting */ }
            _ => {}
        }
    }
    false
}

// ========================
// SERVER
// ========================

pub async fn start_daemon(port: u16) -> Result<()> {
    let daemon = ComponentDaemon::new();

    // Start the persistent registry subscription in the background
    let daemon_for_registry = daemon.clone();
    tokio::spawn(async move {
        daemon_for_registry.connect_to_registry().await;
    });

    let schema = Schema::build(Query, Mutation, Subscription)
        .data(daemon.clone())
        .finish();

    // Health / root endpoint
    let health = warp::path::end().map(|| {
        warp::reply::json(&serde_json::json!({
            "service": "control-plane-daemon",
            "status":  "running"
        }))
    });

    // GraphQL Playground (browser testing)
    let playground = warp::path("playground")
        .and(warp::get())
        .map(|| {
            warp::reply::html(async_graphql::http::playground_source(
                async_graphql::http::GraphQLPlaygroundConfig::new("/graphql")
            ))
        });

    // GraphQL over HTTP (queries + mutations)
    let graphql_post = warp::path("graphql")
        .and(async_graphql_warp::graphql(schema.clone()))
        .and_then(|(schema, request): (Schema<Query, Mutation, Subscription>, Request)| async move {
            Ok::<_, Infallible>(async_graphql_warp::GraphQLResponse::from(schema.execute(request).await))
        });

    // GraphQL over WebSocket (subscriptions — graphql-transport-ws)
    let graphql_ws = async_graphql_warp::graphql_subscription(schema);

    let routes = health
        .or(playground)
        .or(graphql_post.or(graphql_ws))
        .with(
            warp::cors()
                .allow_any_origin()
                .allow_headers(vec!["content-type"])
                .allow_methods(vec!["GET", "POST"])
        );

    info!("🚀 Daemon listening on http://0.0.0.0:{}", port);
    info!("   GraphQL:    http://0.0.0.0:{}/graphql", port);
    info!("   Playground: http://0.0.0.0:{}/playground", port);

    warp::serve(routes).run(([0, 0, 0, 0], port)).await;
    Ok(())
}

// ========================
// MAIN
// ========================

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_file(true)
        .with_line_number(true)
        .with_target(false)
        .with_env_filter("info")
        .init();

    let port = std::env::var("DAEMON_PORT")
        .or_else(|_| std::env::var("PORT"))
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(3001);

    start_daemon(port).await
}
