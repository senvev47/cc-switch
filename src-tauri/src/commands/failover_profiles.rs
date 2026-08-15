//! 命名故障转移路由档案命令（Feature #2 升级：每终端独立故障转移队列）
//!
//! 在既有的「添加到故障转移队列」（共享队列）之上，提供命名档案的 CRUD 与成员
//! 管理。前端「加入故障转移列表」时，除了加入默认（共享）队列外，还可选择加入
//! 某个命名档案或新建档案。终端会话按 rotate/reuse 策略绑定到档案。

use crate::database::{FailoverProfile, FailoverProfileMember};
use crate::store::AppState;

/// 列出某应用的所有档案（含虚拟默认档案，置于首位）。
#[tauri::command]
pub async fn list_failover_profiles(
    state: tauri::State<'_, AppState>,
    app_type: String,
) -> Result<Vec<FailoverProfile>, String> {
    state
        .db
        .list_failover_profiles(&app_type)
        .map_err(|e| e.to_string())
}

/// 创建新档案，返回档案 id。
#[tauri::command]
pub async fn create_failover_profile(
    state: tauri::State<'_, AppState>,
    app_type: String,
    name: String,
) -> Result<String, String> {
    state
        .db
        .create_failover_profile(&app_type, &name)
        .map_err(|e| e.to_string())
}

/// 重命名档案。
#[tauri::command]
pub async fn rename_failover_profile(
    state: tauri::State<'_, AppState>,
    app_type: String,
    profile_id: String,
    new_name: String,
) -> Result<(), String> {
    state
        .db
        .rename_failover_profile(&app_type, &profile_id, &new_name)
        .map_err(|e| e.to_string())
}

/// 删除档案（仅清档案与成员关系行，不删 providers 行）。
#[tauri::command]
pub async fn delete_failover_profile(
    state: tauri::State<'_, AppState>,
    app_type: String,
    profile_id: String,
) -> Result<(), String> {
    state
        .db
        .delete_failover_profile(&app_type, &profile_id)
        .map_err(|e| e.to_string())?;

    // 档案变化后，绑定到该档案的会话已失效（读取侧会检测档案是否仍存在并重新派发），
    // 主动回收避免残留占内存。仅作内存卫生。
    if let Err(e) = state.proxy_service.clear_app_session_routes(&app_type).await {
        log::warn!("[FailoverProfile] 清除应用 {app_type} 会话路由绑定失败: {e}");
    }
    Ok(())
}

/// 获取档案成员（有序）。`profile_id` 为空字符串或 null 表示默认档案（共享队列）。
#[tauri::command]
pub async fn get_failover_profile_members(
    state: tauri::State<'_, AppState>,
    app_type: String,
    profile_id: Option<String>,
) -> Result<Vec<FailoverProfileMember>, String> {
    let pid = profile_id.filter(|s| !s.is_empty());
    state
        .db
        .get_failover_profile_members(&app_type, pid.as_deref())
        .map_err(|e| e.to_string())
}

/// 添加 provider 到档案。
#[tauri::command]
pub async fn add_provider_to_failover_profile(
    state: tauri::State<'_, AppState>,
    app_type: String,
    profile_id: String,
    provider_id: String,
) -> Result<(), String> {
    state
        .db
        .add_provider_to_failover_profile(&app_type, &profile_id, &provider_id)
        .map_err(|e| e.to_string())?;
    // 成员变化后，绑定到该档案的会话链路已变（实时读取，无需失效标记），
    // 不需要清除会话绑定——档案模式下每请求都从 DB 实时取成员。仅日志。
    Ok(())
}

/// 从档案移除 provider（不删 providers 行）。
#[tauri::command]
pub async fn remove_provider_from_failover_profile(
    state: tauri::State<'_, AppState>,
    app_type: String,
    profile_id: String,
    provider_id: String,
) -> Result<(), String> {
    state
        .db
        .remove_provider_from_failover_profile(&app_type, &profile_id, &provider_id)
        .map_err(|e| e.to_string())
}

/// 整体重置档案成员顺序（前端拖拽重排后提交全量有序列表）。
#[tauri::command]
pub async fn reorder_failover_profile_members(
    state: tauri::State<'_, AppState>,
    app_type: String,
    profile_id: String,
    ordered_provider_ids: Vec<String>,
) -> Result<(), String> {
    state
        .db
        .reorder_failover_profile_members(&app_type, &profile_id, &ordered_provider_ids)
        .map_err(|e| e.to_string())
}
