# 档案即端口 — 故障转移未生效调查记录

> 仅观察记录，未修改代码。等用户授权后再改。

## 环境（2026-08-18 22:08 快照）

- cc-switch 版本：commit `cde13cf3`（feat/profile-as-port 分支），已部署，PID 24540
  - 含修复：`is_profile_port` gating（forwarder.rs 4 处）+ handler_context 传递 + ProviderCard P1-only 染色/半分
- claude 档案 `2e0b9531-afac-4b66-a3ec-ea750a70d53b` → 端口 15722，成员：
  - P1 `My Claude copy` (cf3fbe11) → `https://agentrouter.org`，模型 claude-opus-5
  - P2 `My Claude copy copy` (eb1ec710) → `https://ps.air-outer.com`
  - P3 `My Claude copy copy copy` (04b030ee) → `https://k40.shengqainbang.cn`
- 主端口 15721 共享队列 current provider：`My Claude copy copy copy copy` (ffb2f02d) → `https://api.futureppo.top/v1`
- proxy_config(claude)：enabled=1, auto_failover_enabled=1, max_retries=6, first_byte_timeout=90s, idle_timeout=180s
- per_terminal_routing_config.enabled = false（档案端口走显式 profile，不依赖终端路由开关）

## 问题 1：故障转移未切换到下一个供应商（核心问题）

### 现象
- claude 档案终端请求 P1 `My Claude copy`（agentrouter.org）后，客户端报：
  `Waiting for API response` → `API Error: Connection lost mid-response. The response above may be incomplete.`
- 请求日志：`2026-08-18 22:08:16`
- **没有**出现 `FWD-001 继续尝试下一个` —— 即故障转移**没有**切到 P2/P3

### 日志关键行
```
[22:08:15][INFO][forwarder] [Claude] >>> 请求目标: https://api.futureppo.top/v1/chat/completions (model=glm-5.2)   ← 主端口另一终端，正常
[22:08:16][ERROR][response_processor] [Claude] 流错误: error reading a body from connection                    ← 档案端口 P1 流式中断
[22:08:16][WARN][usage::logger] [USG-002] 类型定价未找到，成本将记录为 0: anthropic/claude-opus-5-ps-aws-dst  ← 归因到 P1 模型
```
注意：`22:08:16` 这条流错误由 `response_processor` 报出，**不是** `forwarder` 报的 `[FWD-00x]`。
紧随其后**没有** `[FWD-001] Provider My Claude copy 失败，继续尝试下一个 (1/3)` 这种重试行。

### 对比：能正常触发故障转移的情况
`21:53:14` 同一档案端口，P1 返回明确 HTTP 504：
```
[FWD-001] Provider My Claude copy 失败，继续尝试下一个 (1/3): 上游 HTTP 504: Gateway Time-out
```
说明：**只有当错误被 forwarder 识别为「可重试错误」时**才会切下一个；流式 body 读取异常 (`error reading a body from connection`) 没被纳入可重试错误集，所以不重试。

### 根因判断（待代码确认）
1. 流式响应阶段，上游连接中途断开 → `response_processor` 报 `error reading a body from connection`
2. 该错误类型未在 forwarder 的「可重试错误」判定中 → 不触发 `FWD-001` 重试
3. 已开始流式输出（首字节已过）的请求，按语义也不该重试（会重复输出），但**首字节之前的连接异常**应该可重试 —— 需确认这条错误发生在首字节前还是后
4. 可能还涉及：流式超时（first_byte_timeout=90s / idle_timeout=180s）在档案端口路径上是否真的启用、是否产生可重试错误码

### 需要在代码里确认的点（不改，只列）
- `src-tauri/src/proxy/forwarder.rs`：可重试错误判定函数（`is_retryable` / `should_retry` 之类）是否包含 `error reading a body from connection` / hyper body read error
- `src-tauri/src/proxy/response_processor.rs`：流式读取错误如何回传给 forwarder（是 Result::Err 还是只 log + 提前结束流）
- 流式超时触发后产生的错误是否进入重试路径

## 问题 2：供应商卡片无法在卡片位置退出对应档案（新需求，待实现）

### 现象
- 在供应商卡片上无法直接把该供应商从其所属的命名档案中移除（退出档案）
- 需要新增功能：供应商卡片位置提供「退出该档案」的操作入口

### 待办
- 设计 UI 入口（卡片上的按钮/菜单），调用后端移除 `failover_profile_members` 中对应 (profile_id, provider_id) 行
- 多档案归属时需选择从哪个档案退出（一个 provider 可能是多个档案的成员）

## 二次复现（2026-08-18 22:22:50，members=2）

档案成员已减到 2 个（P1 `My Claude copy`, P2 `My Claude copy copy`）。完整时间线：

```
22:22:50  [INFO][provider_router] 档案端点 /p/2e0b9531 (members=2)
22:22:50  [INFO][forwarder] >>> 请求目标: https://agentrouter.org/v1/messages (model=claude-opus-5)   ← P1 发出
22:25:19  [ERROR][response_processor] 流错误: error reading a body from connection                   ← 上游流式中断（距发出 149s）
22:25:19  [WARN][usage::logger] 归因: anthropic/claude-opus-5-ps-aws-dst                             ← 确认 P1
          （无 FWD-001 继续尝试下一个）                                                                ← 未切 P2
```

### 关键新结论
- 间隔 **149 秒**，远超 `first_byte_timeout=90s`，接近 `idle_timeout=180s`
- 但日志里**没有任何流式超时记录**（无 `first_byte` / `idle` / `超时` 字样）
- 说明：**流式超时机制在档案端口路径上没有兜底**，或触发了但没产生 forwarder 可重试错误码
- 流错误由 `response_processor` 报出 → 未进入 forwarder 可重试路径 → 故障转移链 P2 没机会上

### 三次复现一致性
| 时间 | 间隔 | 错误源 | 切下一个 | 下次请求是否避开 P1 |
|---|---|---|---|---|
| 22:08:16 | — | response_processor `error reading a body` | ❌ 否 | — |
| 22:25:19 | 149s | response_processor `error reading a body` | ❌ 否 | — |
| 22:32:35 | 150s | response_processor `error reading a body` | ❌ 否 | ❌ 否（22:32:56 又发 P1） |

### 四次复现一致性（换 P1 后仍稳定复现）
| 时间 | P1 上游 | 间隔 | 错误源 | 切下一个 | 下次是否避开 P1 |
|---|---|---|---|---|---|
| 22:08:16 | agentrouter | — | response_processor `error reading a body` | ❌ 否 | — |
| 22:25:19 | agentrouter | 149s | 同上 | ❌ 否 | — |
| 22:32:35 | agentrouter | 150s | 同上 | ❌ 否 | ❌ 否（22:32:56 又发 P1） |
| 22:48:00 | air-outer | 152s | 同上 | ❌ 否 | ❌ 否（22:52:19 又发 P1） |

22:45:28 那次用户已手动把 P1 换成 `My Claude copy copy`（air-outer），仍复现 → 证明**与具体上游无关**，是代码逻辑缺陷。

### 对照：明确 HTTP 错误时熔断器/故障转移都正常
- 22:52:16-26 主端口 `My Claude copy copy copy copy` 连续 503 → `[CB-004] 熔断器触发: 连续失败 5 次 → Open` ✓
- 但主端口共享队列 `in_failover_queue=1` 只有它一个 provider，熔断开了也无处可切，继续 503
- 21:53:14 档案端口 P1 明确 504 → `[FWD-001] 继续尝试下一个 (1/3)` ✓

**结论：熔断器/故障转移只对「明确 HTTP 错误（503/504）」生效，对「流式 body 中断（`error reading a body from connection`）」完全不计数、不重试。**

### 稳定复现模式（三次一致）
1. P1 `agentrouter.org` 流式响应在 **~149-150s** 后静默断流
2. `response_processor` 报 `error reading a body from connection`
3. **未触发** `FWD-001 继续尝试下一个`（流式 body 读取错误不在可重试错误集）
4. **未触发** 熔断器：下一次档案请求（22:32:56）**又发给了 P1**，说明 P1 的流式断流没被记为失败 → `provider_health.consecutive_failures` 没递增 → 熔断器没开 → 永远先撞 P1
5. 客户端报 `Connection lost mid-response`
6. 流式超时（first_byte=90s / idle=180s）全程无任何日志记录

## 问题 2：供应商卡片无法在卡片位置退出对应档案（新需求，待实现）

### 现象
- 在供应商卡片上无法直接把该供应商从其所属的命名档案中移除（退出档案）
- 需要新增功能：供应商卡片位置提供「退出该档案」的操作入口

### 待办
- 设计 UI 入口（卡片上的按钮/菜单），调用后端移除 `failover_profile_members` 中对应 (profile_id, provider_id) 行
- 多档案归属时需选择从哪个档案退出（一个 provider 可能是多个档案的成员）

## 问题 3：供应商卡片上下移动后故障转移列表未更新排序（待修）

### 现象
- 在供应商卡片上上下拖动移动后，故障转移列表（档案成员顺序）**没有**更新为卡片对应的位置排序
- 即：UI 卡片顺序变了，但 `failover_profile_members.sort_index` 没相应更新

### 当前 DB 状态（2026-08-18 22:34 手动改后）
```
claude 档案:
  P1(sort_index=0) My Claude copy copy   (eb1ec710, air-outer)
  P2(sort_index=1) My Claude copy        (cf3fbe11, agentrouter)
test 档案:
  P1(sort_index=1) My Claude copy         (cf3fbe11, agentrouter)
```
注意 test 档案 sort_index=1 是不规范的（唯一成员应是 0），需确认移动逻辑是否漏了「单成员归零」。

### 待办（改代码时）
- 拖动卡片后，调用后端更新 `failover_profile_members.sort_index` 以反映新顺序
- 确认拖动的是「档案内排序」还是「全局 provider 列表排序」，两者语义不同：
  - 档案内排序 → 改 `failover_profile_members.sort_index`
  - 全局列表排序 → 改 `providers.sort_index`（与档案故障转移顺序无关）
- 单成员档案移动后应归零 sort_index

## 问题 4：未启动档案的供应商卡片不应改色（待修）

### 现象
- 未启动任何档案的供应商（如 `test` 档案对应的 `My Claude copy`，test 档案无端口、未启动）其卡片颜色**不应该**改变
- 当前实现可能对所有带 profile badge 的 P1 provider 染色，不管该档案是否实际有终端在跑

### 期望
- 只有「该供应商作为某个**已启动**档案（有端口、有终端在用）的 P1」时才染色
- 档案未启动（无 `failover_profile_ports` 行 / 无活动终端）→ 不染色，保持默认卡片外观

### 待办（改代码时）
- ProviderCard 染色判定增加条件：该 profile 是否「已启动」
- 「已启动」判定依据：`failover_profile_ports` 是否有对应 (app_type, profile_id) 行，且该端口的 server 实际在运行
- 前端需拿到「已启动档案集合」来过滤 p1Badges

## 问题 5：关故障转移后本终端才能收到响应（待修）

### 现象
- 主端口 15721 终端报错，手动关闭故障转移 + 终端路由后才恢复收到供应商响应
- 用户描述：「当我手动关闭了故障转移以及终端路由，本终端才能接收到供应商」

### 根因（日志已确认，非档案端口污染）
关闭故障转移之所以「好了」，**不是因为关故障转移本身**，而是因为关闭操作**顺带重启了整个代理服务器**，重启时熔断器状态被清空。

关键时间线：
```
22:52:16  主端口 My Claude copy copy copy copy（共享队列唯一 in_failover_queue=1）连续 503
22:52:26  [CB-004] 熔断器触发: 连续失败 5 次 → Open
22:52:35→22:53:52  [FO-004] 所有供应商均已熔断 （连续刷 ~20 次）
          ↑ 共享队列只有这一个 provider，熔断开了也无下家可切 → FO-004 疯狂挡请求
22:54:03  [Failover] Setting auto_failover_enabled=false  ← 用户关故障转移
22:54:05  已清除全部应用的按终端会话路由绑定 + [SRV-002] 代理服务器已完全停止 ← 服务器重启
22:54:08  >>> futureppo 请求恢复转发 ← 重启后熔断器清空，provider 不再被挡
22:54:42  [USG-002] glm-5-2 成功归因 ← 请求成功
```

### DB 状态确认（重启后）
```
provider_health(claude): 全部 is_healthy=1, consecutive_failures=0  ← 熔断状态清空
in_failover_queue=1(claude): 只有 My Claude copy copy copy copy 一个  ← 共享队列唯一成员
```

### 真正的两个问题
1. **主端口共享队列只有 1 个故障转移成员**：`My Claude copy copy copy copy` 一旦熔断（或上游 503），主端口无下家可切 → `FO-004 所有供应商均已熔断` 直接挡所有请求，直到熔断器冷却（HalfOpen 探测）才能恢复。这是配置问题（队列成员太少），但代码上 `FO-004` 连续刷 ~20 次挡请求也不给个一次性返回，体验差。
2. **熔断器冷却期被 FO-004 挡死**：`22:52:35→22:53:52` 整整 1 分 17 秒内所有主端口请求被挡。熔断器 HalfOpen 探测未及时触发或探测间隔过长，需确认冷却时间配置。

### 与档案端口问题的关系
- 无关。主端口 `FO-004` 是它自己的共享队列熔断问题
- 档案端口 15722 的 `Connection lost mid-response` 是流式 body 中断不重试问题（问题 1）
- 两者独立，不要混为一谈

## 问题 6：熔断器跨档案/主端口共享，新档案请求会熔断旧档案/主端口的供应商（核心待修）

### 用户判断
「新档案的请求导致了旧档案的供应商发生了熔断，需要新档案的熔断机制与旧档案的故障转移列表的熔断机制分开计算。」

### 代码确认（已核实，铁证）
`src-tauri/src/proxy/provider_router.rs`:
```
59:    /// 熔断器管理器 - key 格式: "app_type:provider_id"
60:    circuit_breakers: Arc<RwLock<HashMap<String, Arc<CircuitBreaker>>>>,
184:    /// 熔断器 key（始终为 `app_type:provider_id`），因此熔断器状态、健康统计、
329:    /// `app_type:provider_id`，与全局路径一致。
435:    /// 仍与全局路径共享熔断器 key（`app_type:provider_id`，见 `rotate_providers`），
```
所有路径（主端口 `select_providers` / 会话 `select_providers_for_session` / 档案端口 `select_providers_for_explicit_profile`）都用同一个 `circuit_key = format!("{app_type}:{provider_id}")` → **熔断器按 (app_type, provider_id) 全局共享，不带 profile 维度**。

### 跨污染机制
若某 provider **同时**出现在：
- 档案 A 的故障转移队列（档案端口 A 请求）
- 档案 B 的故障转移队列，或主端口共享队列
则档案 A 把它打熔断后，档案 B / 主端口读到的也是「已熔断」→ 连锁 `FO-004 所有供应商均已熔断` → 旧档案/主端口终端被挡。

### 本次 22:52:26 CB-004 的具体 provider
日志 `[CB-004] 连续失败 5 次 → Open` 未带 provider 名。但 DB 显示 `in_failover_queue=1` 只有 `My Claude copy copy copy copy`，档案端口用的是 `My Claude copy`/`My Claude copy copy` —— 是不同 provider。
**所以本次 CB-004 是 `My Claude copy copy copy copy`（主端口自己的 503）熔断，不是档案端口连累。**
但这不代表跨污染不存在 —— 只要共享同一 provider id 就会跨污染，本次只是恰好没踩到。

### 待修方案（等授权）
熔断器 key 需要带 profile 维度，按使用场景隔离：
- 主端口共享队列：key = `app_type:__shared__:provider_id`（或保持 `app_type:provider_id` 作为共享队列专用）
- 档案端口：key = `app_type:profile_id:provider_id`
- 这样档案端口把某 provider 打熔断，不影响主端口或其它档案对同一 provider 的使用
- 需改动点：
  - `provider_router.rs` 的 `circuit_key` 生成逻辑（`select_providers` / `select_providers_for_explicit_profile` / `rotate_providers` / `allow_provider_request` / `record_result` / `get_circuit_breaker_stats` 等）
  - forwarder 调用 `record_success`/`record_failure` 时需带上 profile 上下文
  - 熔断器 reset/stats 查询也要按新 key
- 注意：`is_profile_port` 已在 forwarder 里隔离了「全局副作用」（不写 current_providers / 不 hot_switch），但熔断器 key 还没隔离 —— 这是 `is_profile_port` 修复的遗漏项

## 监控状态

- 持续 tail `C:\Users\47\.cc-switch\logs\cc-switch.log`，过滤 FWD/流错误/超时/熔断/切换
- 等待用户再次复现 `Connection lost mid-response`，抓那一刻完整 forwarder + response_processor 日志链

## 不做的事
- 不改代码（等用户授权）
- 不升级上游 v3.20.0
