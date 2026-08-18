//! HTTP代理服务器
//!
//! 基于Axum的HTTP服务器，处理代理请求
//!
//! Uses a manual hyper HTTP/1.1 accept loop with `preserve_header_case(true)` so
//! that the original header-name casing from the CLI client is captured in a
//! `HeaderCaseMap` extension.  This map is later forwarded to the upstream via
//! the hyper-based HTTP client, producing wire-level header casing identical to
//! a direct (non-proxied) CLI request.

use super::{
    failover_switch::FailoverSwitchManager,
    handlers,
    log_codes::srv as log_srv,
    provider_router::ProviderRouter,
    providers::{codex_chat_history::CodexChatHistoryStore, gemini_shadow::GeminiShadowStore},
    types::*,
    ProxyError,
};
use crate::database::Database;
use axum::{
    extract::DefaultBodyLimit,
    routing::{any, get, post},
    Router,
};
use hyper_util::rt::TokioIo;
use socket2::{Domain, Protocol, Socket, Type};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, RwLock};
use tokio::task::JoinHandle;

/// 绑定一个开启 `SO_REUSEADDR` 的 TCP 监听器，并在配置端口被占用时**自动回退**到
/// 下一个可用端口。
///
/// 解决两类「路由打不开」问题：
/// 1. **进程重叠 / TIME_WAIT**：app 重启时旧 socket 可能尚未完全释放，`bind` 返回
///    10048 (WSAEADDRINUSE)。`SO_REUSEADDR` 允许在 TIME_WAIT 上重新绑定。
/// 2. **端口被其它进程占用**：若配置端口被占用且无法复用，顺序探测
///    `listen_port..=listen_port+200`，再退到 `0`（OS 分配）。不再因端口冲突让
///    `恢复代理接管状态` 整条链失败、路由彻底打不开。
///
/// 注意：Windows 上 `SO_REUSEADDR` 语义比 POSIX 更宽松（允许多 socket 同时绑同一端口）。
/// 这里仅用于跨重启/重叠的 TIME_WAIT 复用，不依赖其「多 socket 共享」语义。
fn bind_listener_with_reuse_and_fallback(
    listen_address: &str,
    preferred_port: u16,
) -> Result<(TcpListener, SocketAddr), ProxyError> {
    // 解析一次地址族：127.0.0.1 / 0.0.0.0 → IPv4；[::] / ::1 → IPv6。
    let probe: SocketAddr = format!("{listen_address}:0")
        .parse()
        .map_err(|e| ProxyError::BindFailed(format!("无效的监听地址 {listen_address}: {e}")))?;
    let domain = if probe.is_ipv4() {
        Domain::IPV4
    } else {
        Domain::IPV6
    };

    // 候选端口序列：优先配置端口，然后 +1..+200，最后 0（交给 OS）。
    let mut candidates: Vec<u16> = Vec::with_capacity(202);
    candidates.push(preferred_port);
    for offset in 1u16..=200u16 {
        candidates.push(preferred_port.saturating_add(offset));
    }
    candidates.push(0);

    let mut last_err: Option<String> = None;
    for port in candidates {
        match bind_reuse_one(listen_address, port, domain) {
            Ok((listener, addr)) => {
                if port != preferred_port && port != 0 {
                    log::warn!(
                        "配置端口 {preferred_port} 被占用，已回退到空闲端口 {} ({listen_address})",
                        addr.port()
                    );
                } else if port == 0 {
                    log::warn!(
                        "配置端口 {preferred_port} 及其后 200 个端口均被占用，由 OS 分配端口: {}",
                        addr.port()
                    );
                }
                return Ok((listener, addr));
            }
            Err(e) => {
                last_err = Some(e.to_string());
            }
        }
    }
    Err(ProxyError::BindFailed(format!(
        "绑定 {listen_address}:{preferred_port} 失败（已尝试回退端口）: {}",
        last_err.unwrap_or_else(|| "未知错误".to_string())
    )))
}

/// 用 `socket2` 建一个带 `SO_REUSEADDR` 的监听 socket，bind + listen 后转交 tokio。
fn bind_reuse_one(
    listen_address: &str,
    port: u16,
    domain: Domain,
) -> Result<(TcpListener, SocketAddr), ProxyError> {
    let addr: SocketAddr = format!("{listen_address}:{port}")
        .parse()
        .map_err(|e| ProxyError::BindFailed(format!("无效的地址 {listen_address}:{port}: {e}")))?;
    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))
        .map_err(|e| ProxyError::BindFailed(format!("创建 socket 失败: {e}")))?;
    // 允许 TIME_WAIT / 重启重叠时重新绑定，避免 10048。
    let _ = socket.set_reuse_address(true);
    socket
        .bind(&addr.into())
        .map_err(|e| ProxyError::BindFailed(format!("bind {addr} 失败: {e}")))?;
    // backlog 同 tokio 默认（1024）。
    socket
        .listen(1024)
        .map_err(|e| ProxyError::BindFailed(format!("listen {addr} 失败: {e}")))?;
    socket
        .set_nonblocking(true)
        .map_err(|e| ProxyError::BindFailed(format!("设置非阻塞失败: {e}")))?;
    // socket2 0.6 开启 "all" feature 后有 `impl From<Socket> for std::net::TcpListener`，
    // `.into()` 直接取回 std listener（该 From 不返回 Result）。
    let std_listener: std::net::TcpListener = socket.into();
    let local_addr = std_listener
        .local_addr()
        .map_err(|e| ProxyError::BindFailed(format!("读取 local_addr 失败: {e}")))?;
    let tokio_listener =
        TcpListener::from_std(std_listener).map_err(|e| ProxyError::BindFailed(e.to_string()))?;
    Ok((tokio_listener, local_addr))
}

/// 代理服务器状态（共享）
#[derive(Clone)]
pub struct ProxyState {
    pub db: Arc<Database>,
    pub config: Arc<RwLock<ProxyConfig>>,
    pub status: Arc<RwLock<ProxyStatus>>,
    pub start_time: Arc<RwLock<Option<std::time::Instant>>>,
    /// 每个应用类型当前使用的 provider (app_type -> (provider_id, provider_name))
    pub current_providers: Arc<RwLock<std::collections::HashMap<String, (String, String)>>>,
    /// 共享的 ProviderRouter（持有熔断器状态，跨所有请求/所有端口保持）
    pub provider_router: Arc<ProviderRouter>,
    /// Gemini Native shadow state，用于 thoughtSignature / tool call 回放
    pub gemini_shadow: Arc<GeminiShadowStore>,
    /// Codex Chat bridge history，用于恢复 previous_response_id 指向的 tool call
    pub codex_chat_history: Arc<CodexChatHistoryStore>,
    /// AppHandle，用于发射事件和更新托盘菜单
    pub app_handle: Option<tauri::AppHandle>,
    /// 故障转移切换管理器
    pub failover_manager: Arc<FailoverSwitchManager>,
    /// 「档案即端口」：本 server 绑定的命名档案 `(app_type, profile_id)`。
    ///
    /// - `None`：主端口 server，走既有路由（`select_providers_for_session` / `select_providers`）。
    /// - `Some`：档案端口 server，该端口的所有请求固定走 `select_providers_for_explicit_profile`。
    ///
    /// 绑定由端口本身唯一确定（见 `failover_profile_ports` 表），请求路径不再携带档案 id，
    /// 故 handler 不需要从 URL 取 profile_id。
    pub profile_binding: Arc<Option<(String, String)>>,
}

/// 代理HTTP服务器
///
/// `#[derive(Clone)]`：所有字段均为 `Arc`，克隆廉价。`ProxyService::start_profile_server`
/// 需要从 `profile_servers` map 中克隆一份 server 句柄，以便在释放读锁后对其做
/// liveness 探测 / `stop()`（避免读锁期间持锁等待 TCP/IO）。
#[derive(Clone)]
pub struct ProxyServer {
    config: ProxyConfig,
    state: ProxyState,
    shutdown_tx: Arc<RwLock<Option<oneshot::Sender<()>>>>,
    /// 服务器任务句柄，用于等待服务器实际关闭
    server_handle: Arc<RwLock<Option<JoinHandle<()>>>>,
    /// 实际绑定的端口（`start()` 后填充，前端开终端要用）。
    bound_port: Arc<RwLock<Option<u16>>>,
}

impl ProxyServer {
    /// 创建代理服务器。
    ///
    /// `provider_router` 与 `failover_manager` 由调用方（`ProxyService`）持有并注入，
    /// 保证主端口与各档案端口 server **共享同一份熔断器/故障转移状态**——
    /// 否则不同端口的健康统计会分裂，违背既有不变量。
    pub fn new(
        config: ProxyConfig,
        db: Arc<Database>,
        app_handle: Option<tauri::AppHandle>,
        provider_router: Arc<ProviderRouter>,
        failover_manager: Arc<FailoverSwitchManager>,
        profile_binding: Option<(String, String)>,
    ) -> Self {
        let state = ProxyState {
            db,
            config: Arc::new(RwLock::new(config.clone())),
            status: Arc::new(RwLock::new(ProxyStatus::default())),
            start_time: Arc::new(RwLock::new(None)),
            current_providers: Arc::new(RwLock::new(std::collections::HashMap::new())),
            provider_router,
            gemini_shadow: Arc::new(GeminiShadowStore::default()),
            codex_chat_history: Arc::new(CodexChatHistoryStore::default()),
            app_handle,
            failover_manager,
            profile_binding: Arc::new(profile_binding),
        };

        Self {
            config,
            state,
            shutdown_tx: Arc::new(RwLock::new(None)),
            server_handle: Arc::new(RwLock::new(None)),
            bound_port: Arc::new(RwLock::new(None)),
        }
    }

    /// 返回 server 实际绑定的端口（`start()` 后可用）。
    pub async fn bound_port(&self) -> Option<u16> {
        *self.bound_port.read().await
    }

    pub async fn start(&self) -> Result<ProxyServerInfo, ProxyError> {
        // 检查是否已在运行
        if self.shutdown_tx.read().await.is_some() {
            return Err(ProxyError::AlreadyRunning);
        }

        // 创建关闭通道
        let (shutdown_tx, shutdown_rx) = oneshot::channel();

        // 构建路由
        let app = self.build_router();

        // 绑定监听器：开启 SO_REUSEADDR，且配置端口被占用时自动回退到下一个空闲端口，
        // 避免进程重叠 / TIME_WAIT 导致 bind 10048 → 「恢复代理接管状态」整条链失败 → 路由打不开。
        let (listener, local_addr) = bind_listener_with_reuse_and_fallback(
            &self.config.listen_address,
            self.config.listen_port,
        )?;

        log::info!(
            "[{}] 代理服务器启动于 {local_addr}（绑定档案: {}）",
            log_srv::STARTED,
            match self.state.profile_binding.as_ref() {
                Some((app, pid)) => format!("{app}/{pid}"),
                None => "主端口（共享队列/既有路由）".to_string(),
            }
        );

        *self.bound_port.write().await = Some(local_addr.port());
        let actual_port = local_addr.port();

        // 更新全局代理端口，用于系统代理检测
        crate::proxy::http_client::set_proxy_port(actual_port);

        // 保存关闭句柄
        *self.shutdown_tx.write().await = Some(shutdown_tx);

        // 更新状态
        let mut status = self.state.status.write().await;
        status.running = true;
        status.address = self.config.listen_address.clone();
        status.port = actual_port;
        drop(status);

        // 记录启动时间
        *self.state.start_time.write().await = Some(std::time::Instant::now());

        // 启动服务器 — 使用手动 hyper HTTP/1.1 accept loop
        // 开启 preserve_header_case 以捕获客户端请求头的原始大小写
        let state = self.state.clone();
        let handle = tokio::spawn(async move {
            let mut shutdown_rx = shutdown_rx;
            loop {
                tokio::select! {
                    result = listener.accept() => {
                        let (stream, _remote_addr) = match result {
                            Ok(v) => v,
                            Err(e) => {
                                log::error!("[{SRV}] accept 失败: {e}", SRV = log_srv::ACCEPT_ERR);
                                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                                continue;
                            }
                        };

                        let app = app.clone();
                        tokio::spawn(async move {
                            // Peek raw TCP bytes to capture original header casing
                            // before hyper parses (and lowercases) the header names.
                            let original_cases = {
                                let mut peek_buf = vec![0u8; 8192];
                                match stream.peek(&mut peek_buf).await {
                                    Ok(n) => {
                                        let cases = super::hyper_client::OriginalHeaderCases::from_raw_bytes(&peek_buf[..n]);
                                        log::debug!(
                                            "[ProxyServer] Peeked {} bytes, captured {} header casings",
                                            n, cases.cases.len()
                                        );
                                        cases
                                    }
                                    Err(e) => {
                                        log::debug!("[ProxyServer] peek failed (non-fatal): {e}");
                                        super::hyper_client::OriginalHeaderCases::default()
                                    }
                                }
                            };

                            // service_fn 将 axum Router（tower::Service）桥接到 hyper
                            let service = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                                let mut router = app.clone();
                                let cases = original_cases.clone();
                                async move {
                                    // 将 hyper::body::Incoming 转为 axum::body::Body，保留 extensions
                                    let (mut parts, body) = req.into_parts();

                                    // Insert our own header case map alongside hyper's internal one
                                    parts.extensions.insert(cases);

                                    let body = axum::body::Body::new(body);
                                    let axum_req = http::Request::from_parts(parts, body);
                                    <Router as tower::Service<http::Request<axum::body::Body>>>::call(&mut router, axum_req).await
                                }
                            });

                            if let Err(e) = hyper::server::conn::http1::Builder::new()
                                .preserve_header_case(true)
                                .serve_connection(TokioIo::new(stream), service)
                                .await
                            {
                                // Connection reset / broken pipe 等在代理场景下很常见，debug 级别
                                log::debug!("[{SRV}] connection error: {e}", SRV = log_srv::CONN_ERR);
                            }
                        });
                    }
                    _ = &mut shutdown_rx => {
                        break;
                    }
                }
            }

            // 服务器停止后更新状态
            state.status.write().await.running = false;
            *state.start_time.write().await = None;
        });

        // 保存服务器任务句柄
        *self.server_handle.write().await = Some(handle);

        Ok(ProxyServerInfo {
            address: self.config.listen_address.clone(),
            port: actual_port,
            started_at: chrono::Utc::now().to_rfc3339(),
        })
    }

    pub async fn stop(&self) -> Result<(), ProxyError> {
        // 1. 发送关闭信号
        if let Some(tx) = self.shutdown_tx.write().await.take() {
            let _ = tx.send(());
        } else {
            return Err(ProxyError::NotRunning);
        }

        // 2. 等待服务器任务结束（带 5 秒超时保护）
        let result = if let Some(handle) = self.server_handle.write().await.take() {
            match tokio::time::timeout(std::time::Duration::from_secs(5), handle).await {
                Ok(Ok(())) => {
                    log::info!("[{}] 代理服务器已完全停止", log_srv::STOPPED);
                    Ok(())
                }
                Ok(Err(e)) => {
                    log::warn!("[{}] 代理服务器任务异常终止: {e}", log_srv::TASK_ERROR);
                    Err(ProxyError::StopFailed(e.to_string()))
                }
                Err(_) => {
                    log::warn!(
                        "[{}] 代理服务器停止超时（5秒），强制继续",
                        log_srv::STOP_TIMEOUT
                    );
                    Err(ProxyError::StopTimeout)
                }
            }
        } else {
            Ok(())
        };

        // 3. 清空 bound_port。`bound_port()` 在 `start()` 成功后被写入，此前永不被
        //    清空——即使 server 已停止，`bound_port()` 仍返回 `Some(port)`。这会让
        //    `start_profile_server` 的短路路径误判「端口仍在服务」并返回死端口
        //    （终端 `ANTHROPIC_BASE_URL` 指向死端口 → claude code 网关发现失败 →
        //    退回旧档案的 gateway-models 缓存）。`stop()` 完成后清空它，配合
        //    `start_profile_server` 的 TCP liveness 探测，僵尸 server 不再能伪装存活。
        *self.bound_port.write().await = None;

        result
    }

    pub async fn get_status(&self) -> ProxyStatus {
        let mut status = self.state.status.read().await.clone();

        // 计算运行时间
        if let Some(start) = *self.state.start_time.read().await {
            status.uptime_seconds = start.elapsed().as_secs();
        }

        // 从 current_providers HashMap 获取每个应用类型当前正在使用的 provider
        let current_providers = self.state.current_providers.read().await;
        status.active_targets = current_providers
            .iter()
            .map(|(app_type, (provider_id, provider_name))| ActiveTarget {
                app_type: app_type.clone(),
                provider_id: provider_id.clone(),
                provider_name: provider_name.clone(),
            })
            .collect();

        status
    }

    /// 更新某个应用类型当前“目标供应商”（用于 UI 展示 active_targets）
    ///
    /// 注意：这不代表该供应商一定已经处理过请求，而是用于“热切换/启用故障转移立即切 P1”
    /// 等场景下，让 UI 能立刻反映最新目标。
    pub async fn set_active_target(&self, app_type: &str, provider_id: &str, provider_name: &str) {
        let mut current_providers = self.state.current_providers.write().await;
        current_providers.insert(
            app_type.to_string(),
            (provider_id.to_string(), provider_name.to_string()),
        );
    }

    /// 组装路由表。
    ///
    /// 单挂载（裸路径）。档案身份由**端口本身**携带（「档案即端口」）：每个命名档案独占一个
    /// 代理端口，`ProxyState::profile_binding` 记录该端口绑定的档案，handler 据此选 provider。
    /// 不再需要 `/p/:profile_id` 路径前缀，也就没有 `Option<Path<HashMap>>` 双挂载的坑。
    ///
    /// 注意：**不要**为前缀路径加任何重定向。claude code 的网关模型发现用
    /// `redirect: "error"` 发起 `GET {base_url}/v1/models`，任何 301 都会让发现失败。
    fn build_router(&self) -> Router {
        Self::api_routes()
            // 提高默认请求体大小限制（避免 413 Payload Too Large）
            .layer(DefaultBodyLimit::max(200 * 1024 * 1024))
            .with_state(self.state.clone())
    }

    fn api_routes() -> Router<ProxyState> {
        Router::new()
            // 健康检查
            .route("/health", get(handlers::health_check))
            .route("/status", get(handlers::get_status))
            // Claude API (支持带前缀和不带前缀两种格式)
            .route("/v1/messages", post(handlers::handle_messages))
            .route("/claude/v1/messages", post(handlers::handle_messages))
            // Claude Desktop 3P 本地 gateway（独立 provider namespace）
            .route(
                "/claude-desktop/v1/models",
                get(handlers::handle_claude_desktop_models),
            )
            .route(
                "/claude-desktop/v1/messages",
                post(handlers::handle_claude_desktop_messages),
            )
            // OpenAI Chat Completions API (Codex CLI，支持带前缀和不带前缀)
            .route("/chat/completions", post(handlers::handle_chat_completions))
            .route(
                "/v1/chat/completions",
                post(handlers::handle_chat_completions),
            )
            .route(
                "/v1/v1/chat/completions",
                post(handlers::handle_chat_completions),
            )
            .route(
                "/codex/v1/chat/completions",
                post(handlers::handle_chat_completions),
            )
            // OpenAI Models API (Codex CLI reachability check)
            .route("/models", get(handlers::handle_models))
            .route("/v1/models", get(handlers::handle_models))
            // OpenAI Responses API (Codex CLI，支持带前缀和不带前缀)
            .route("/responses", post(handlers::handle_responses))
            .route("/v1/responses", post(handlers::handle_responses))
            .route("/v1/v1/responses", post(handlers::handle_responses))
            .route("/codex/v1/responses", post(handlers::handle_responses))
            // Grok Build uses the Responses protocol but has an independent
            // provider namespace and failover queue.
            .route(
                "/grokbuild/v1/responses",
                post(handlers::handle_grokbuild_responses),
            )
            // OpenAI Responses Compact API (Codex CLI 远程压缩，透传)
            .route(
                "/responses/compact",
                post(handlers::handle_responses_compact),
            )
            .route(
                "/v1/responses/compact",
                post(handlers::handle_responses_compact),
            )
            .route(
                "/v1/v1/responses/compact",
                post(handlers::handle_responses_compact),
            )
            .route(
                "/codex/v1/responses/compact",
                post(handlers::handle_responses_compact),
            )
            .route(
                "/grokbuild/v1/responses/compact",
                post(handlers::handle_grokbuild_responses_compact),
            )
            // Gemini API (支持带前缀和不带前缀)
            //
            // 用 `any(..)` 覆盖所有 HTTP 方法：除了 POST `:generateContent` /
            // `:streamGenerateContent` / `:countTokens` 之外，Gemini SDK / CLI 还会发
            // GET `/models`、GET `/models/<id>` 等只读端点。如果只挂 POST，这些 GET
            // 请求会在路由层 404，绕过本地代理的统计、整流和故障转移。
            .route("/v1beta/*path", any(handlers::handle_gemini))
            .route("/gemini/v1beta/*path", any(handlers::handle_gemini))
            // Gemini 的 GA 版本也叫 /v1，给原 SDK 留一条出口
            .route("/gemini/v1/*path", any(handlers::handle_gemini))
    }

    /// 在不重启服务的情况下更新运行时配置
    pub async fn apply_runtime_config(&self, config: &ProxyConfig) {
        *self.state.config.write().await = config.clone();
    }

    /// 热更新熔断器配置
    ///
    /// 将新配置应用到所有已创建的熔断器实例
    pub async fn update_circuit_breaker_configs(
        &self,
        config: super::circuit_breaker::CircuitBreakerConfig,
    ) {
        self.state.provider_router.update_all_configs(config).await;
    }

    pub async fn update_circuit_breaker_config_for_app(
        &self,
        app_type: &str,
        config: super::circuit_breaker::CircuitBreakerConfig,
    ) {
        self.state
            .provider_router
            .update_app_configs(app_type, config)
            .await;
    }

    /// 重置指定 Provider 的熔断器
    ///
    /// `profile_id` 为 `None` 时重置主端口共享 key 的熔断器；为 `Some(pid)` 时
    /// 重置档案端口专属 key。现有命令调用方传 `None`（主端口重置）。
    pub async fn reset_provider_circuit_breaker(
        &self,
        provider_id: &str,
        app_type: &str,
        profile_id: Option<&str>,
    ) {
        self.state
            .provider_router
            .reset_provider_breaker(provider_id, app_type, profile_id)
            .await;
    }

    /// 清除全部应用的按终端会话路由绑定（Feature #2）。
    ///
    /// 在关闭「按终端路由」总开关时调用，立即释放此前已绑定的会话起点，
    /// 避免它们在进程生命周期内残留占内存。开关关闭后 `select_providers_for_session`
    /// 会在第一步就退化为 `select_providers`，因此即使不调用也不会产生功能问题，
    /// 此处仅为内存卫生。
    pub async fn clear_all_session_routes(&self) {
        self.state.provider_router.clear_all_session_routes().await;
    }

    /// 清除指定应用下所有终端的会话路由绑定（Feature #2）。
    ///
    /// 在该应用的故障转移队列发生增删、或该应用关闭自动故障转移时调用：
    /// 此时同一 app_type 下的既有绑定其 `queue_len_at_bind` 已与当前队列不一致
    /// （或 failover 已关导致 `select_providers_for_session` 退化），主动回收避免
    /// 残留。与 `clear_all_session_routes` 同样仅为内存卫生——读取侧本就会忽略
    /// 队列长度不匹配的过期绑定。
    pub async fn clear_app_session_routes(&self, app_type: &str) {
        self.state
            .provider_router
            .clear_app_session_routes(app_type)
            .await;
    }
}
