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

/// Deadline for an MFE capability call (/authorize, /load, /render, /refresh).
const MFE_CALL_TIMEOUT_SECS: u64 = 4;

const GRAPHQL_SUBPROTOCOL: &str = "graphql-transport-ws";

// Component types that carry canonical control-plane payloads over the legacy
// envelope during migration (ADR-054 / PLATFORM-CONTRACT v3.2).
const RESOLUTION_COMPONENT_TYPE: &str = "RESOLUTION";
const EXPERIENCE_COMPONENT_TYPE: &str = "EXPERIENCE";
const RESOLUTION_ERROR_COMPONENT_TYPE: &str = "RESOLUTION_ERROR";

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
    /// Open string per PLATFORM-CONTRACT v3.2 — the control plane does not
    /// own a fixed component type library. Legacy CARD | NOTIFICATION | FORM
    /// plus RESOLUTION | EXPERIENCE | RESOLUTION_ERROR all flow through here.
    pub r#type: String,
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

    // ── Resolution pipeline state (ADR-054 / PLATFORM-CONTRACT v3.2) ──

    /// sessionId -> SessionContext (raw JSON) from the last action that carried one.
    sessions: Arc<DashMap<String, serde_json::Value>>,

    /// sessionKey -> (mfe, capability) currently active — drives render-vs-refresh.
    active_resolutions: Arc<DashMap<String, (String, String)>>,

    /// MFE names whose load() has completed (load runs once per MFE).
    loaded_mfes: Arc<DashMap<String, ()>>,

    /// mfeName -> MfeRegistration (raw JSON), synced from the registry's GET /mfes.
    mfe_directory: Arc<DashMap<String, serde_json::Value>>,
}

impl ComponentDaemon {
    pub fn new() -> Self {
        let (broadcast_tx, _) = broadcast::channel(100);
        Self {
            components: Arc::new(DashMap::new()),
            broadcast_tx,
            sessions: Arc::new(DashMap::new()),
            active_resolutions: Arc::new(DashMap::new()),
            loaded_mfes: Arc::new(DashMap::new()),
            mfe_directory: Arc::new(DashMap::new()),
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

        // Step 1b: Capture session context (read from the raw payload — the
        // typed Action drops unknown fields). Later RESOLUTION components only
        // carry a sessionId; the daemon rehydrates the full SessionContext
        // (user, jwt, application, locale) when invoking the resolved MFE.
        if let Some(ctx) = message.payload.get("context") {
            if let Some(sid) = ctx.get("sessionId").and_then(|v| v.as_str()) {
                self.sessions.insert(sid.to_string(), ctx.clone());
            }
        }

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

    /// Called when the registry subscription delivers a new component.
    ///
    /// Two cases (ADR-054 / PLATFORM-CONTRACT v3.2):
    ///   RESOLUTION component → run the resolution pipeline (authorize →
    ///   load/render/refresh the resolved MFE → relay its experience)
    ///   anything else → store-then-broadcast (EXPERIENCE passthrough + legacy)
    async fn handle_component_from_registry(&self, component: Component) -> Result<()> {
        info!("DAE-210 COMPONENT_FROM_REGISTRY — id={}", component.id);

        if component.r#type == RESOLUTION_COMPONENT_TYPE
            && component.data.get("mfe").and_then(|v| v.as_str()).is_some()
        {
            let daemon = self.clone();
            let data = component.data.clone();
            tokio::spawn(async move {
                if let Err(e) = daemon.handle_resolution(data).await {
                    error!("DAE-299 RESOLUTION_ERROR — {}", e);
                }
            });
            return Ok(());
        }

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

    // ── Resolution pipeline (ADR-054 / PLATFORM-CONTRACT v3.2) ─────────────────
    // Rust port of DaemonService.handleResolution in @control-plane/contracts —
    // the order is a protocol invariant: lookup → authorize → (load once) →
    // render | refresh → relay the RenderedExperience as an EXPERIENCE component.

    async fn handle_resolution(&self, data: serde_json::Value) -> Result<()> {
        let mfe = data.get("mfe").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let capability = data.get("capability").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let props = data.get("props").cloned().unwrap_or_else(|| serde_json::json!({}));
        let correlation_id = data.get("correlationId").and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let session_key = data.get("sessionId").and_then(|v| v.as_str())
            .unwrap_or("default").to_string();
        let session = data.get("sessionId").and_then(|v| v.as_str())
            .and_then(|sid| self.sessions.get(sid).map(|s| s.value().clone()));

        info!("DAE-250 RESOLUTION_RECEIVED — mfe={} capability={} correlationId={}", mfe, capability, correlation_id);

        // Step 1: Lookup the MFE's capability endpoints
        let registration = match self.lookup_mfe(&mfe).await {
            Some(r) => r,
            None => {
                self.publish_resolution_error(&mfe, &capability, &correlation_id, &format!("unknown MFE \"{mfe}\""));
                return Ok(());
            }
        };
        let base_url = registration.get("baseUrl").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let jwt = session.as_ref().and_then(|s| s.get("jwt")).and_then(|v| v.as_str()).map(|s| s.to_string());
        let mfe_context = self.mfe_context(session.as_ref(), &correlation_id);

        // Step 2: Authorize (MFEs that don't declare authorizeAccess are open)
        let declares_authorize = registration.get("capabilities")
            .and_then(|v| v.as_array())
            .map(|caps| caps.iter().any(|c| c.as_str() == Some("authorizeAccess")))
            .unwrap_or(false);
        if declares_authorize {
            let body = serde_json::json!({
                "inputs": { "token": jwt, "context": mfe_context },
                "context": mfe_context
            });
            match self.mfe_post(&base_url, "/authorize", jwt.as_deref(), body).await {
                Ok(response) if response.get("authorized").and_then(|v| v.as_bool()) == Some(true) => {}
                Ok(_) => {
                    self.publish_resolution_error(&mfe, &capability, &correlation_id, "access denied");
                    return Ok(());
                }
                Err(e) => {
                    self.publish_resolution_error(&mfe, &capability, &correlation_id, &e.to_string());
                    return Ok(());
                }
            }
        }

        // Step 4 (refresh branch): same MFE + capability already active → refresh
        let already_active = self.active_resolutions.get(&session_key)
            .map(|a| a.value().0 == mfe && a.value().1 == capability)
            .unwrap_or(false);
        if already_active {
            let body = serde_json::json!({
                "inputs": { "full": false, "capability": capability, "props": props },
                "context": mfe_context
            });
            if let Err(e) = self.mfe_post(&base_url, "/refresh", jwt.as_deref(), body).await {
                self.publish_resolution_error(&mfe, &capability, &correlation_id, &e.to_string());
            } else {
                info!("DAE-252 MFE_REFRESHED — mfe={} capability={}", mfe, capability);
            }
            return Ok(());
        }

        // Step 3: Load once per MFE before its first render
        if !self.loaded_mfes.contains_key(&mfe) {
            let body = serde_json::json!({ "inputs": { "config": {} }, "context": mfe_context });
            if let Err(e) = self.mfe_post(&base_url, "/load", jwt.as_deref(), body).await {
                self.publish_resolution_error(&mfe, &capability, &correlation_id, &e.to_string());
                return Ok(());
            }
            self.loaded_mfes.insert(mfe.clone(), ());
            info!("DAE-251 MFE_LOADED — mfe={}", mfe);
        }

        // Step 4 (render branch): the MFE produces its own experience
        let body = serde_json::json!({
            "inputs": { "capability": capability, "props": props },
            "context": mfe_context
        });
        let response = match self.mfe_post(&base_url, "/render", jwt.as_deref(), body).await {
            Ok(r) => r,
            Err(e) => {
                self.publish_resolution_error(&mfe, &capability, &correlation_id, &e.to_string());
                return Ok(());
            }
        };

        let element = response.get("element").cloned().unwrap_or(serde_json::Value::Null);
        let output = element.get("output").cloned()
            .unwrap_or_else(|| if element.is_null() { response.clone() } else { element.clone() });
        let content_type = element.get("contentType").and_then(|v| v.as_str())
            .or_else(|| registration.get("contentType").and_then(|v| v.as_str()))
            .unwrap_or("application/json")
            .to_string();
        let experience_id = response.get("id").and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let created_at = Utc::now();
        let experience = serde_json::json!({
            "id": experience_id,
            "mfe": mfe,
            "capability": capability,
            "output": output,
            "contentType": content_type,
            "props": props,
            "createdAt": created_at.to_rfc3339()
        });

        // Step 5: Relay — store + broadcast as an EXPERIENCE component
        self.active_resolutions.insert(session_key, (mfe.clone(), capability.clone()));
        let component = Component {
            id: experience_id.clone(),
            r#type: EXPERIENCE_COMPONENT_TYPE.to_string(),
            data: experience,
            created_at,
        };
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
                acknowledged: true,
                correlation_id: Some(correlation_id),
                error: None,
            }),
        };
        let _ = self.broadcast_tx.send(message);
        info!("DAE-253 EXPERIENCE_RELAYED — mfe={} capability={} expId={}", mfe, capability, experience_id);
        Ok(())
    }

    fn publish_resolution_error(&self, mfe: &str, capability: &str, correlation_id: &str, reason: &str) {
        error!("DAE-299 RESOLUTION_FAILED — mfe={} reason={}", mfe, reason);
        let component = serde_json::json!({
            "id": correlation_id,
            "type": RESOLUTION_ERROR_COMPONENT_TYPE,
            "data": { "mfe": mfe, "capability": capability, "reason": reason },
            "createdAt": Utc::now().to_rfc3339()
        });
        let _ = self.broadcast_tx.send(DaemonMessage {
            direction: MessageDirection::Component,
            kind: Some(MessageKind::ComponentUpdate),
            payload: component,
            metadata: Some(MessageMetadata {
                acknowledged: false,
                correlation_id: Some(correlation_id.to_string()),
                error: Some(reason.to_string()),
            }),
        });
    }

    /// The subset of SessionContext the MFE's shared Context understands.
    fn mfe_context(&self, session: Option<&serde_json::Value>, correlation_id: &str) -> serde_json::Value {
        let get = |key: &str| session.and_then(|s| s.get(key)).cloned().unwrap_or(serde_json::Value::Null);
        serde_json::json!({
            "requestId": correlation_id,
            "sessionId": get("sessionId"),
            "user": get("user"),
            "application": get("application"),
            "locale": get("locale")
        })
    }

    // ── MFE directory + HTTP capability invocation ──────────────────────────────

    fn registry_http_url(&self) -> String {
        std::env::var("REGISTRY_HTTP_URL").unwrap_or_else(|_| {
            let host = std::env::var("REGISTRY_HOST").unwrap_or_else(|_| "registry".to_string());
            let port = std::env::var("REGISTRY_PORT").unwrap_or_else(|_| "4000".to_string());
            format!("http://{host}:{port}")
        })
    }

    async fn lookup_mfe(&self, name: &str) -> Option<serde_json::Value> {
        if let Some(registration) = self.mfe_directory.get(name) {
            return Some(registration.value().clone());
        }
        match self.http_get(&format!("{}/mfes", self.registry_http_url())).await {
            Ok(body) => {
                if let Some(mfes) = body.get("mfes").and_then(|v| v.as_array()) {
                    for registration in mfes {
                        if let Some(reg_name) = registration.get("name").and_then(|v| v.as_str()) {
                            self.mfe_directory.insert(reg_name.to_string(), registration.clone());
                        }
                    }
                }
            }
            Err(e) => warn!("DAE-254 MFE_DIRECTORY_SYNC_FAILED — {}", e),
        }
        self.mfe_directory.get(name).map(|r| r.value().clone())
    }

    async fn http_get(&self, url: &str) -> Result<serde_json::Value> {
        let client = hyper::Client::new();
        let uri: hyper::Uri = url.parse()?;
        let response = tokio::time::timeout(
            Duration::from_secs(MFE_CALL_TIMEOUT_SECS),
            client.get(uri),
        ).await??;
        if !response.status().is_success() {
            anyhow::bail!("GET {url} responded {}", response.status());
        }
        let bytes = hyper::body::to_bytes(response.into_body()).await?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    async fn mfe_post(
        &self,
        base_url: &str,
        path: &str,
        jwt: Option<&str>,
        body: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let client = hyper::Client::new();
        let uri: hyper::Uri = format!("{}{}", base_url.trim_end_matches('/'), path).parse()?;
        let mut builder = hyper::Request::builder()
            .method(hyper::Method::POST)
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(jwt) = jwt {
            builder = builder.header("authorization", format!("Bearer {jwt}"));
        }
        let request = builder.body(hyper::Body::from(body.to_string()))?;
        let response = tokio::time::timeout(
            Duration::from_secs(MFE_CALL_TIMEOUT_SECS),
            client.request(request),
        ).await??;
        if !response.status().is_success() {
            anyhow::bail!("MFE {path} responded {}", response.status());
        }
        let bytes = hyper::body::to_bytes(response.into_body()).await?;
        Ok(serde_json::from_slice(&bytes)?)
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
