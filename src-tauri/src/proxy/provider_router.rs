//! 供应商路由器模块
//!
//! 负责选择和管理代理目标供应商，实现智能故障转移

use crate::app_config::AppType;
use crate::database::Database;
use crate::error::AppError;
use crate::provider::Provider;
use crate::proxy::circuit_breaker::{AllowResult, CircuitBreaker, CircuitBreakerConfig};
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::RwLock;

/// 单个会话绑定的路由起点信息（Feature #2：按终端路由）
///
/// 一旦某个终端会话首次绑定了一条 P1→P2→… 起点偏移，后续该会话的所有请求
/// 都沿用同一偏移，使「一个终端 = 一套路由链」成立。绑定仅当故障转移队列
/// 长度变化（增删/重排 provider）时失效，触发下次请求重新派发。
#[derive(Clone, Debug)]
struct SessionRoute {
    /// 绑定时故障转移队列的长度；与当前队列长度不一致则视为过期绑定
    queue_len_at_bind: usize,
    /// 起点偏移：`ordered_ids[offset]` 为该会话的 P1
    offset: usize,
}

/// 供应商路由器
pub struct ProviderRouter {
    /// 数据库连接
    db: Arc<Database>,
    /// 熔断器管理器 - key 格式: "app_type:provider_id"
    circuit_breakers: Arc<RwLock<HashMap<String, Arc<CircuitBreaker>>>>,
    /// 按终端会话绑定的路由起点 - key 格式: "app_type:session_id"
    ///
    /// 仅在 `PerTerminalRoutingConfig.enabled = true` 且该应用开启了自动故障转移
    /// 时被读写；其它情况下此 map 保持为空（`select_providers_for_session`
    /// 会直接退化为 `select_providers`），零回归。
    session_routes: Arc<RwLock<HashMap<String, SessionRoute>>>,
}

impl ProviderRouter {
    /// 创建新的供应商路由器
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            db,
            circuit_breakers: Arc::new(RwLock::new(HashMap::new())),
            session_routes: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 选择可用的供应商（支持故障转移）
    ///
    /// 返回按优先级排序的可用供应商列表：
    /// - 故障转移关闭时：仅返回当前供应商
    /// - 故障转移开启时：仅使用故障转移队列，按队列顺序依次尝试（P1 → P2 → ...）
    pub async fn select_providers(&self, app_type: &str) -> Result<Vec<Provider>, AppError> {
        let mut result = Vec::new();
        let mut total_providers = 0usize;
        let mut circuit_open_count = 0usize;

        // 检查该应用的自动故障转移开关是否开启（从 proxy_config 表读取）
        let auto_failover_enabled = match self.db.get_proxy_config_for_app(app_type).await {
            Ok(config) => config.auto_failover_enabled,
            Err(e) => {
                log::error!("[{app_type}] 读取 proxy_config 失败: {e}，默认禁用故障转移");
                false
            }
        };

        if auto_failover_enabled {
            // 故障转移开启：仅按队列顺序依次尝试（P1 → P2 → ...）
            let all_providers = self.db.get_all_providers(app_type)?;

            // 使用 DAO 返回的排序结果，确保和前端展示一致
            let ordered_ids: Vec<String> = self
                .db
                .get_failover_queue(app_type)?
                .into_iter()
                .map(|item| item.provider_id)
                .collect();

            total_providers = ordered_ids.len();

            for provider_id in ordered_ids {
                let Some(provider) = all_providers.get(&provider_id).cloned() else {
                    continue;
                };

                let circuit_key = format!("{app_type}:{}", provider.id);
                let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;

                if breaker.is_available().await {
                    result.push(provider);
                } else {
                    circuit_open_count += 1;
                }
            }
        } else {
            // 故障转移关闭：仅使用当前供应商，跳过熔断器检查
            let current_id = AppType::from_str(app_type)
                .ok()
                .and_then(|app_enum| {
                    crate::settings::get_effective_current_provider(&self.db, &app_enum)
                        .ok()
                        .flatten()
                })
                .or_else(|| self.db.get_current_provider(app_type).ok().flatten());

            if let Some(current_id) = current_id {
                if let Some(current) = self.db.get_provider_by_id(&current_id, app_type)? {
                    total_providers = 1;
                    result.push(current);
                }
            }
        }

        if result.is_empty() {
            if total_providers > 0 && circuit_open_count == total_providers {
                log::warn!("[{app_type}] [FO-004] 所有供应商均已熔断");
                return Err(AppError::AllProvidersCircuitOpen);
            } else {
                log::warn!("[{app_type}] [FO-005] 未配置供应商");
                return Err(AppError::NoProvidersConfigured);
            }
        }

        Ok(result)
    }

    /// 按会话选择可用的供应商（Feature #2：按终端路由）
    ///
    /// 当满足以下全部条件时，按「会话绑定的起点偏移」对 `ordered_ids` 做轮转，
    /// 使不同终端会话各自从不同 provider 起步：
    ///   1. `PerTerminalRoutingConfig.enabled = true`；
    ///   2. 该应用开启了自动故障转移（关闭时本函数直接退化为 `select_providers`，
    ///      与历史版本行为完全一致）；
    ///   3. `client_provided = true`（调用方确认本次 `session_id` 来自客户端稳定标识，
    ///      而非 `extract_session_id` 生成的临时 UUID）。
    ///
    /// 第 3 条是内存安全阀：缺失稳定会话标识的请求会拿到一个一次性 UUID，
    /// 若也写入 `session_routes` 则每条请求都新增一条永不清除的条目（`clear_*`
    /// 驱逐函数未接线）。一次性 UUID 没有终端连续性，按终端路由对它无意义，
    /// 因此这类请求一律退化为全局 `select_providers`，零回归且不泄漏。
    ///
    /// 起点（offset）的绑定规则：
    ///   - 首次见到该会话：若策略为 `rotate`，offset = 当前已绑定会话数（模队列长度），
    ///     使新终端尽量落在下一个 provider；策略为 `reuse`（默认）时 offset = 0，
    ///     即沿用全局队列起点 P1。
    ///   - 已绑定且队列长度未变：复用原 offset。
    ///   - 队列长度发生变化（增删/重排 provider）：旧绑定失效，按「首次见到」重新派发。
    ///
    /// 关键不变量：轮转只改变起点，**不改变** provider 集合，也**不改变**熔断器 key
    /// （始终为 `app_type:provider_id`），因此熔断器状态、健康统计、故障转移语义
    /// 与 `select_providers` 完全一致，仅 P1→P2→… 的起跑线因会话而异。
    pub async fn select_providers_for_session(
        &self,
        app_type: &str,
        session_id: &str,
        client_provided: bool,
    ) -> Result<Vec<Provider>, AppError> {
        // 1. 读取按终端路由配置；失败或关闭时直接退化为全局选择，零回归。
        let routing_config = self.db.get_per_terminal_routing_config().unwrap_or_default();
        if !routing_config.enabled {
            return self.select_providers(app_type).await;
        }

        // 2. 自动故障转移关闭时同样退化为全局选择 —— 单 provider 无需轮转，
        //    也避免在故障转移关闭路径里意外写入会话绑定。
        let auto_failover_enabled = match self.db.get_proxy_config_for_app(app_type).await {
            Ok(config) => config.auto_failover_enabled,
            Err(e) => {
                log::error!("[{app_type}] 读取 proxy_config 失败: {e}，禁用按终端路由");
                return self.select_providers(app_type).await;
            }
        };
        if !auto_failover_enabled {
            return self.select_providers(app_type).await;
        }

        // 3. 缺失稳定会话标识（一次性 UUID）时退化为全局选择，避免内存泄漏：
        //    见函数文档第 3 条不变量。这类请求没有终端连续性，无需绑定起点。
        if !client_provided {
            return self.select_providers(app_type).await;
        }

        // 3. 取全局有序 id（与 select_providers 同源，确保 provider 集合与熔断器 key 一致）。
        let all_providers = self.db.get_all_providers(app_type)?;
        let ordered_ids: Vec<String> = self
            .db
            .get_failover_queue(app_type)?
            .into_iter()
            .map(|item| item.provider_id)
            .collect();

        let queue_len = ordered_ids.len();
        if queue_len == 0 {
            log::warn!("[{app_type}] [FO-005] 未配置供应商（按终端路由）");
            return Err(AppError::NoProvidersConfigured);
        }

        // 4. 解析 / 绑定该会话的起点偏移。
        let session_key = format!("{app_type}:{session_id}");
        let offset: Option<usize> = {
            let routes = self.session_routes.read().await;
            match routes.get(&session_key) {
                Some(route) if route.queue_len_at_bind == queue_len => Some(route.offset),
                _ => None,
            }
        };

        let offset = match offset {
            Some(off) => off,
            None => {
                // 首次见到该会话（或队列长度变化导致旧绑定失效）：派发新 offset。
                let new_offset = if routing_config.is_rotate_policy() {
                    // rotate：按当前已绑定会话数轮转，使新终端尽量落在不同 provider。
                    let routes = self.session_routes.read().await;
                    let count = routes
                        .keys()
                        .filter(|k| k.split_once(':').map(|(a, _)| a) == Some(app_type))
                        .count();
                    if queue_len == 0 {
                        0
                    } else {
                        count % queue_len
                    }
                } else {
                    // reuse（默认）：新终端沿用全局起点 P1。
                    0
                };

                let bound_provider = ordered_ids.get(new_offset).cloned().unwrap_or_default();
                {
                    let mut routes = self.session_routes.write().await;
                    routes.insert(
                        session_key.clone(),
                        SessionRoute {
                            queue_len_at_bind: queue_len,
                            offset: new_offset,
                        },
                    );
                }
                log::info!(
                    "[{app_type}] 按终端路由：会话 {session_id} 绑定起点 P1 = {} (queue_len={})",
                    bound_provider,
                    queue_len
                );
                new_offset
            }
        };

        // 5. 按 offset 轮转 ordered_ids，再走与 select_providers 完全一致的熔断器过滤。
        let rotated: Vec<String> = (0..queue_len)
            .map(|i| ordered_ids[(i + offset) % queue_len].clone())
            .collect();

        let mut result = Vec::new();
        let mut circuit_open_count = 0usize;

        for provider_id in &rotated {
            let Some(provider) = all_providers.get(provider_id).cloned() else {
                continue;
            };
            let circuit_key = format!("{app_type}:{}", provider.id);
            let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;
            if breaker.is_available().await {
                result.push(provider);
            } else {
                circuit_open_count += 1;
            }
        }

        if result.is_empty() {
            if circuit_open_count == queue_len {
                log::warn!("[{app_type}] [FO-004] 所有供应商均已熔断（按终端路由）");
                return Err(AppError::AllProvidersCircuitOpen);
            } else {
                log::warn!("[{app_type}] [FO-005] 未配置供应商（按终端路由）");
                return Err(AppError::NoProvidersConfigured);
            }
        }

        Ok(result)
    }

    /// 清除指定会话的路由绑定（会话结束时调用，避免内存无限增长）。
    ///
    /// 未找到时静默返回；非关键路径，不返回错误。
    pub async fn clear_session_route(&self, app_type: &str, session_id: &str) {
        let session_key = format!("{app_type}:{session_id}");
        let mut routes = self.session_routes.write().await;
        routes.remove(&session_key);
    }

    /// 清除指定应用下所有会话的路由绑定（配置/队列变更时调用）。
    pub async fn clear_app_session_routes(&self, app_type: &str) {
        let prefix = format!("{app_type}:");
        let mut routes = self.session_routes.write().await;
        routes.retain(|k, _| !k.starts_with(&prefix));
    }

    /// 清除全部应用的会话路由绑定（关闭按终端路由时调用）。
    pub async fn clear_all_session_routes(&self) {
        let mut routes = self.session_routes.write().await;
        routes.clear();
    }

    /// 请求执行前获取熔断器“放行许可”
    ///
    /// - Closed：直接放行
    /// - Open：超时到达后切到 HalfOpen 并放行一次探测
    /// - HalfOpen：按限流规则放行探测
    ///
    /// 注意：调用方必须在请求结束后通过 `record_result()` 释放 HalfOpen 名额，
    /// 否则会导致该 Provider 长时间无法进入探测状态。
    pub async fn allow_provider_request(&self, provider_id: &str, app_type: &str) -> AllowResult {
        let circuit_key = format!("{app_type}:{provider_id}");
        let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;
        breaker.allow_request().await
    }

    /// 记录供应商请求结果
    pub async fn record_result(
        &self,
        provider_id: &str,
        app_type: &str,
        used_half_open_permit: bool,
        success: bool,
        error_msg: Option<String>,
    ) -> Result<(), AppError> {
        // 1. 按应用独立获取熔断器配置
        let failure_threshold = match self.db.get_proxy_config_for_app(app_type).await {
            Ok(app_config) => app_config.circuit_failure_threshold,
            Err(_) => 5, // 默认值
        };

        // 2. 更新熔断器状态
        let circuit_key = format!("{app_type}:{provider_id}");
        let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;

        if success {
            breaker.record_success(used_half_open_permit).await;
        } else {
            breaker.record_failure(used_half_open_permit).await;
        }

        // 3. 更新数据库健康状态（使用配置的阈值）
        self.db
            .update_provider_health_with_threshold(
                provider_id,
                app_type,
                success,
                error_msg.clone(),
                failure_threshold,
            )
            .await?;

        Ok(())
    }

    /// 重置熔断器（手动恢复）
    pub async fn reset_circuit_breaker(&self, circuit_key: &str) {
        let breakers = self.circuit_breakers.read().await;
        if let Some(breaker) = breakers.get(circuit_key) {
            breaker.reset().await;
        }
    }

    /// 重置指定供应商的熔断器
    pub async fn reset_provider_breaker(&self, provider_id: &str, app_type: &str) {
        let circuit_key = format!("{app_type}:{provider_id}");
        self.reset_circuit_breaker(&circuit_key).await;
    }

    /// 仅释放 HalfOpen permit，不影响健康统计（neutral 接口）
    ///
    /// 用于整流器等场景：请求结果不应计入 Provider 健康度，
    /// 但仍需释放占用的探测名额，避免 HalfOpen 状态卡死
    pub async fn release_permit_neutral(
        &self,
        provider_id: &str,
        app_type: &str,
        used_half_open_permit: bool,
    ) {
        if !used_half_open_permit {
            return;
        }
        let circuit_key = format!("{app_type}:{provider_id}");
        let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;
        breaker.release_half_open_permit();
    }

    /// 更新所有熔断器的配置（热更新）
    pub async fn update_all_configs(&self, config: CircuitBreakerConfig) {
        let breakers = self.circuit_breakers.read().await;
        for breaker in breakers.values() {
            breaker.update_config(config.clone()).await;
        }
    }

    /// 更新指定应用已创建熔断器的配置（热更新）
    pub async fn update_app_configs(&self, app_type: &str, config: CircuitBreakerConfig) {
        let prefix = format!("{app_type}:");
        let breakers = self.circuit_breakers.read().await;
        for (key, breaker) in breakers.iter() {
            if key.starts_with(&prefix) {
                breaker.update_config(config.clone()).await;
            }
        }
    }

    /// 获取熔断器状态
    #[allow(dead_code)]
    pub async fn get_circuit_breaker_stats(
        &self,
        provider_id: &str,
        app_type: &str,
    ) -> Option<crate::proxy::circuit_breaker::CircuitBreakerStats> {
        let circuit_key = format!("{app_type}:{provider_id}");
        let breakers = self.circuit_breakers.read().await;

        if let Some(breaker) = breakers.get(&circuit_key) {
            Some(breaker.get_stats().await)
        } else {
            None
        }
    }

    /// 获取或创建熔断器
    async fn get_or_create_circuit_breaker(&self, key: &str) -> Arc<CircuitBreaker> {
        // 先尝试读锁获取
        {
            let breakers = self.circuit_breakers.read().await;
            if let Some(breaker) = breakers.get(key) {
                return breaker.clone();
            }
        }

        // 如果不存在，获取写锁创建
        let mut breakers = self.circuit_breakers.write().await;

        // 双重检查，防止竞争条件
        if let Some(breaker) = breakers.get(key) {
            return breaker.clone();
        }

        // 从 key 中提取 app_type (格式: "app_type:provider_id")
        let app_type = key.split(':').next().unwrap_or("claude");

        // 按应用独立读取熔断器配置
        let config = match self.db.get_proxy_config_for_app(app_type).await {
            Ok(app_config) => crate::proxy::circuit_breaker::CircuitBreakerConfig {
                failure_threshold: app_config.circuit_failure_threshold,
                success_threshold: app_config.circuit_success_threshold,
                timeout_seconds: app_config.circuit_timeout_seconds as u64,
                error_rate_threshold: app_config.circuit_error_rate_threshold,
                min_requests: app_config.circuit_min_requests,
            },
            Err(_) => crate::proxy::circuit_breaker::CircuitBreakerConfig::default(),
        };

        let breaker = Arc::new(CircuitBreaker::new(config));
        breakers.insert(key.to_string(), breaker.clone());

        breaker
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use serde_json::json;
    use serial_test::serial;
    use std::env;
    use tempfile::TempDir;

    struct TempHome {
        #[allow(dead_code)]
        dir: TempDir,
        original_home: Option<String>,
        original_userprofile: Option<String>,
        original_test_home: Option<String>,
    }

    impl TempHome {
        fn new() -> Self {
            let dir = TempDir::new().expect("failed to create temp home");
            let original_home = env::var("HOME").ok();
            let original_userprofile = env::var("USERPROFILE").ok();
            let original_test_home = env::var("CC_SWITCH_TEST_HOME").ok();

            env::set_var("HOME", dir.path());
            env::set_var("USERPROFILE", dir.path());
            env::set_var("CC_SWITCH_TEST_HOME", dir.path());
            crate::settings::reload_settings().expect("reload settings");

            Self {
                dir,
                original_home,
                original_userprofile,
                original_test_home,
            }
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            match &self.original_home {
                Some(value) => env::set_var("HOME", value),
                None => env::remove_var("HOME"),
            }

            match &self.original_userprofile {
                Some(value) => env::set_var("USERPROFILE", value),
                None => env::remove_var("USERPROFILE"),
            }

            match &self.original_test_home {
                Some(value) => env::set_var("CC_SWITCH_TEST_HOME", value),
                None => env::remove_var("CC_SWITCH_TEST_HOME"),
            }
        }
    }

    #[tokio::test]
    #[serial]
    async fn test_provider_router_creation() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let router = ProviderRouter::new(db);

        let breaker = router.get_or_create_circuit_breaker("claude:test").await;
        assert!(breaker.allow_request().await.allowed);
    }

    #[tokio::test]
    #[serial]
    async fn test_failover_disabled_uses_current_provider() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.set_current_provider("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router.select_providers("claude").await.unwrap();

        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "a");
    }

    #[tokio::test]
    #[serial]
    async fn test_failover_enabled_uses_queue_order_ignoring_current() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        // 设置 sort_index 来控制顺序：b=1, a=2
        let mut provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        provider_a.sort_index = Some(2);
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.sort_index = Some(1);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.set_current_provider("claude", "a").unwrap();

        db.add_to_failover_queue("claude", "b").unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();

        // 启用自动故障转移（使用新的 proxy_config API）
        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router.select_providers("claude").await.unwrap();

        assert_eq!(providers.len(), 2);
        // 故障转移开启时：仅按队列顺序选择（忽略当前供应商）
        assert_eq!(providers[0].id, "b");
        assert_eq!(providers[1].id, "a");
    }

    #[tokio::test]
    #[serial]
    async fn test_failover_enabled_uses_queue_only_even_if_current_not_in_queue() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.sort_index = Some(1);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.set_current_provider("claude", "a").unwrap();

        // 只把 b 加入故障转移队列（模拟“当前供应商不在队列里”的常见配置）
        db.add_to_failover_queue("claude", "b").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router.select_providers("claude").await.unwrap();

        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "b");
    }

    #[tokio::test]
    #[serial]
    async fn test_select_providers_does_not_consume_half_open_permit() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        db.update_circuit_breaker_config(&CircuitBreakerConfig {
            failure_threshold: 1,
            timeout_seconds: 0,
            ..Default::default()
        })
        .await
        .unwrap();

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();

        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();

        // 启用自动故障转移（使用新的 proxy_config API）
        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());

        router
            .record_result("b", "claude", false, false, Some("fail".to_string()))
            .await
            .unwrap();

        let providers = router.select_providers("claude").await.unwrap();
        assert_eq!(providers.len(), 2);

        assert!(router.allow_provider_request("b", "claude").await.allowed);
    }

    #[tokio::test]
    #[serial]
    async fn test_release_permit_neutral_frees_half_open_slot() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        // 配置熔断器：1 次失败即熔断，0 秒超时立即进入 HalfOpen
        db.update_circuit_breaker_config(&CircuitBreakerConfig {
            failure_threshold: 1,
            timeout_seconds: 0,
            ..Default::default()
        })
        .await
        .unwrap();

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        db.save_provider("claude", &provider_a).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();

        // 启用自动故障转移
        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());

        // 触发熔断：1 次失败
        router
            .record_result("a", "claude", false, false, Some("fail".to_string()))
            .await
            .unwrap();

        // 第一次请求：获取 HalfOpen 探测名额
        let first = router.allow_provider_request("a", "claude").await;
        assert!(first.allowed);
        assert!(first.used_half_open_permit);

        // 第二次请求应被拒绝（名额已被占用）
        let second = router.allow_provider_request("a", "claude").await;
        assert!(!second.allowed);

        // 使用 release_permit_neutral 释放名额（不影响健康统计）
        router
            .release_permit_neutral("a", "claude", first.used_half_open_permit)
            .await;

        // 第三次请求应被允许（名额已释放）
        let third = router.allow_provider_request("a", "claude").await;
        assert!(third.allowed);
        assert!(third.used_half_open_permit);
    }
}
