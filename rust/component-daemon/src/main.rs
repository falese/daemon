use std::convert::Infallible;
use std::time::Duration;
use std::sync::Arc;
use std::collections::HashMap;

use anyhow::{Context, Result};
use async_graphql::*;
use async_stream::stream;
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt, stream::SplitSink};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio::time::sleep;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{error, info, warn};
use warp::Filter;
use uuid::Uuid;

// ========================
// TYPES
// ========================

#[derive(Clone, Debug, Serialize, Deserialize, SimpleObject)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: String,
    pub r#type: ComponentType,
    pub data: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Enum, Copy, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ComponentType {
    Card,
    Notification,
    Form,
}



// ========================
// DAEMON
// ========================

#[derive(Clone)]
pub struct ComponentDaemon {
    components: Arc<DashMap<String, Component>>,
    all_components: Arc<tokio::sync::Mutex<Vec<Component>>>,
    broadcast_tx: broadcast::Sender<Component>,
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

    pub async fn start(&self) -> Result<()> {
        let daemon = self.clone();
        tokio::spawn(async move {
            daemon.connect_to_registry().await;
        });

        info!("🚀 Daemon: Started");
        Ok(())
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

    async fn try_connect_to_registry(&self) -> Result<()> {
        let url = "ws://localhost:4000/graphql";
        
        info!("🔌 Daemon: Attempting to connect to {}", url);
        
        // Try the exact approach that works with your Node.js setup
        use tokio_tungstenite::tungstenite;
        
        let request = tungstenite::http::Request::builder()
            .uri(url)
            .header("Host", "localhost:4000")
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header("Sec-WebSocket-Key", tungstenite::handshake::client::generate_key())
            .header("Sec-WebSocket-Protocol", "graphql-ws")
            .body(())?;
            
        info!("🔌 Daemon: Built WebSocket request with graphql-ws protocol");
        
        match connect_async(request).await {
            Ok((ws_stream, response)) => {
                info!("✅ Daemon: Connected to registry, status: {}", response.status());
                
                let (mut write, mut read) = ws_stream.split();

                // Send connection_init exactly like Node.js version
                let init_message = serde_json::json!({
                    "type": "connection_init"
                });
                let init_json = serde_json::to_string(&init_message)?;
                info!("📤 Daemon: Sending connection_init: {}", init_json);
                write.send(Message::Text(init_json)).await?;

                while let Some(message) = read.next().await {
                    match message {
                        Ok(Message::Text(text)) => {
                            info!("📨 Daemon: Raw message from registry: {}", text);
                            if let Err(e) = self.handle_registry_message(&mut write, &text).await {
                                error!("Error handling registry message: {}", e);
                            }
                        }
                        Ok(Message::Close(frame)) => {
                            if let Some(f) = frame {
                                info!("🔌 Daemon: Registry connection closed: code={:?}, reason='{}'", f.code, f.reason);
                            } else {
                                info!("🔌 Daemon: Registry connection closed (no close frame)");
                            }
                            break;
                        }
                        Ok(Message::Pong(_)) => {
                            // Ignore pong messages
                        }
                        Ok(Message::Ping(data)) => {
                            // Respond to ping
                            let _ = write.send(Message::Pong(data)).await;
                        }
                        Err(e) => {
                            error!("❌ Daemon: WebSocket error: {}", e);
                            break;
                        }
                        _ => {}
                    }
                }
            }
            Err(e) => {
                error!("❌ Daemon: Connection with subprotocol failed: {}", e);
                
                // Fallback: try without subprotocol
                info!("🔌 Daemon: Trying without subprotocol...");
                match connect_async(url).await {
                    Ok((ws_stream, response)) => {
                        info!("✅ Daemon: Connected without subprotocol, status: {}", response.status());
                        
                        let (mut write, mut read) = ws_stream.split();
                        
                        let init_message = serde_json::json!({
                            "type": "connection_init"
                        });
                        let init_json = serde_json::to_string(&init_message)?;
                        info!("📤 Daemon: Sending connection_init (no subprotocol): {}", init_json);
                        write.send(Message::Text(init_json)).await?;

                        while let Some(message) = read.next().await {
                            match message {
                                Ok(Message::Text(text)) => {
                                    info!("📨 Daemon: Raw message: {}", text);
                                    if let Err(e) = self.handle_registry_message(&mut write, &text).await {
                                        error!("Error handling registry message: {}", e);
                                    }
                                }
                                Ok(Message::Close(frame)) => {
                                    if let Some(f) = frame {
                                        info!("🔌 Daemon: Connection closed: code={:?}, reason='{}'", f.code, f.reason);
                                    }
                                    break;
                                }
                                Err(e) => {
                                    error!("❌ Daemon: WebSocket error: {}", e);
                                    break;
                                }
                                _ => {}
                            }
                        }
                    }
                    Err(e2) => {
                        error!("❌ Daemon: Both connection attempts failed: {} / {}", e, e2);
                        return Err(anyhow::anyhow!("Failed to connect to registry"));
                    }
                }
            }
        }

        Ok(())
    }

    async fn handle_registry_message(
        &self,
        write: &mut SplitSink<
            tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
            Message,
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
                info!("📡 Daemon: Registry connection acknowledged, starting subscription...");
                // Send start subscription using subscriptions-transport-ws format
                let subscription = serde_json::json!({
                    "id": "registry-sub",
                    "type": "start",
                    "payload": {
                        "query": "subscription { componentUpdate { id type data createdAt } }"
                    }
                });
                let sub_json = serde_json::to_string(&subscription)?;
                info!("📡 Daemon: Sending subscription: {}", sub_json);
                write.send(Message::Text(sub_json)).await?;
            }
            "data" => {
                if let Some(payload) = message.get("payload") {
                    if let Some(errors) = payload.get("errors") {
                        error!("❌ Daemon: GraphQL subscription errors: {}", 
                              serde_json::to_string_pretty(errors)?);
                    } else if let Some(data) = payload.get("data") {
                        if let Some(component_update) = data.get("componentUpdate") {
                            match serde_json::from_value::<Component>(component_update.clone()) {
                                Ok(component) => {
                                    info!("📦 Daemon: Received component from registry: {}", component.id);
                                    self.handle_component_from_registry(component).await?;
                                },
                                Err(e) => {
                                    error!("❌ Daemon: Failed to deserialize component: {}\nValue: {}", e, component_update);
                                }
                            }
                        }
                    }
                }
            }
            "error" => {
                if let Some(payload) = message.get("payload") {
                    error!("❌ Daemon: GraphQL error from registry: {}", payload);
                }
            }
            "complete" => {
                info!("✅ Daemon: Subscription completed");
            }
            "ka" => {
                // Keep-alive message from subscriptions-transport-ws
                info!("💓 Daemon: Keep-alive from registry");
            }
            _ => {
                info!("ℹ️ Daemon: Unknown message type '{}': {}", msg_type, text);
            }
        }

        Ok(())
    }

    async fn handle_component_from_registry(&self, component: Component) -> Result<()> {
        info!("📦 Daemon: Forwarding component {} to renderer", component.id);
        self.components.insert(component.id.clone(), component.clone());
        // Store every received component for history/counting
        let count = {
            let mut all = self.all_components.lock().await;
            all.push(component.clone());
            all.len()
        };
        info!("📦 Daemon: Total received components so far: {}", count);
        // Broadcast to all GraphQL subscriptions
        let _ = self.broadcast_tx.send(component.clone());
        Ok(())
    }



    pub fn get_components(&self) -> Vec<Component> {
        self.components.iter().map(|entry| entry.value().clone()).collect()
    }

    pub async fn get_all_components_count(&self) -> usize {
        let all = self.all_components.lock().await;
        all.len()
    }

    pub fn subscribe_to_updates(&self) -> broadcast::Receiver<Component> {
        self.broadcast_tx.subscribe()
    }
}

// ========================
// GRAPHQL SCHEMA
// ========================

pub struct Query;

#[Object]
impl Query {
    async fn components(&self, ctx: &async_graphql::Context<'_>) -> Result<Vec<Component>, Error> {
        let daemon = ctx.data::<ComponentDaemon>()
            .map_err(|_| Error::new("ComponentDaemon not found in context"))?;
        Ok(daemon.get_components())
    }
}

pub struct Subscription;

#[Subscription]
impl Subscription {
    
    async fn rendererUpdate(&self, ctx: &async_graphql::Context<'_>) -> Result<impl futures::Stream<Item = Component>, Error> {
        info!("📡 Daemon: Renderer subscribed to updates");
        
        let daemon = ctx.data::<ComponentDaemon>()
            .map_err(|_| Error::new("ComponentDaemon not found in context"))?;
        
        let mut receiver = daemon.subscribe_to_updates();
        
        let stream = stream! {
            while let Ok(component) = receiver.recv().await {
                yield component;
            }
        };
        
        Ok(stream)
    }
}



// ========================
// SERVER
// ========================

pub async fn start_daemon(port: u16) -> Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt::init();

    let daemon = ComponentDaemon::new();
    daemon.start().await?;

    // Create GraphQL schema
    let schema = Schema::build(Query, EmptyMutation, Subscription)
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
                async_graphql::Schema<Query, EmptyMutation, Subscription>,
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

    info!("🚀 Component Daemon running on http://localhost:{}", port);
    info!("📡 GraphQL: http://localhost:{}/graphql", port);
    info!("🎮 Playground: http://localhost:{}/playground", port);

    warp::serve(routes)
        .run(([127, 0, 0, 1], port))
        .await;

    Ok(())
}

// ========================
// MAIN
// ========================

#[tokio::main]
async fn main() -> Result<()> {
    start_daemon(3001).await
}