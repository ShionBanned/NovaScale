mod engine;

use std::sync::Arc;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio_tungstenite::{
    accept_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};
use tracing::{info, warn};

use engine::{InferenceConfig, InferenceEngine};

#[derive(Deserialize)]
#[serde(tag = "type")]
enum ClientMsg {
    #[serde(rename = "hello")]
    Hello { version: Option<String> },
    #[serde(rename = "config")]
    Config { mode: String, sharpness: f32 },
}

#[derive(Serialize)]
struct ServerHello<'a> {
    #[serde(rename = "type")]
    msg_type: &'a str,
    backend: &'a str,
    status: &'a str,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let engine = Arc::new(InferenceEngine::new("./models"));
    info!("NovaScale Sprint 3 Sidecar initialized: {}", engine.backend_name);

    let addr = "127.0.0.1:19480";
    let listener = TcpListener::bind(addr)
        .await
        .expect("Failed to bind 127.0.0.1:19480");
    info!("Listening for NovaScale extension on ws://{}/novascale-stream", addr);

    let ws_cfg = WebSocketConfig {
        max_message_size: Some(128 * 1024 * 1024),
        max_frame_size: Some(128 * 1024 * 1024),
        ..Default::default()
    };

    while let Ok((stream, peer)) = listener.accept().await {
        let eng = Arc::clone(&engine);
        tokio::spawn(async move {
            let Ok(ws_stream) = accept_async_with_config(stream, Some(ws_cfg)).await else {
                return;
            };
            info!("Extension connected from {}", peer);
            let (mut write, mut read) = ws_stream.split();
            let mut cfg = InferenceConfig::default();

            let hello = serde_json::to_string(&ServerHello {
                msg_type: "ready",
                backend: &eng.backend_name,
                status: "ok",
            })
            .unwrap_or_default();
            let _ = write.send(Message::Text(hello)).await;

            while let Some(msg) = read.next().await {
                match msg {
                    Ok(Message::Text(txt)) => {
                        if let Ok(parsed) = serde_json::from_str::<ClientMsg>(&txt) {
                            match parsed {
                                ClientMsg::Hello { version } => {
                                    info!("Client hello v{:?}", version);
                                }
                                ClientMsg::Config { mode, sharpness } => {
                                    cfg.mode = mode;
                                    cfg.sharpness = sharpness.clamp(0.0, 1.0);
                                }
                            }
                        }
                    }
                    Ok(Message::Binary(bin)) => {
                        if bin.len() < 8 {
                            continue;
                        }
                        let w = u32::from_le_bytes(bin[0..4].try_into().unwrap()) as usize;
                        let h = u32::from_le_bytes(bin[4..8].try_into().unwrap()) as usize;
                        let payload = &bin[8..];

                        if let Some((out_w, out_h, out_rgba)) = eng.upscale_rgba8(payload, w, h, &cfg) {
                            let mut resp = Vec::with_capacity(8 + out_rgba.len());
                            resp.extend_from_slice(&(out_w as u32).to_le_bytes());
                            resp.extend_from_slice(&(out_h as u32).to_le_bytes());
                            resp.extend_from_slice(&out_rgba);
                            if write.send(Message::Binary(resp)).await.is_err() {
                                break;
                            }
                        }
                    }
                    Ok(Message::Close(_)) => break,
                    Err(e) => {
                        warn!("WebSocket error: {}", e);
                        break;
                    }
                    _ => {}
                }
            }
            info!("Extension disconnected: {}", peer);
        });
    }
}
