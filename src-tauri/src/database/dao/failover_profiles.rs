//! 故障转移路由档案 DAO（Feature #2 升级：按终端独立故障转移队列）
//!
//! 在既有的「共享故障转移队列」（providers.in_failover_queue + sort_index）之上，
//! 引入「命名路由档案」：每个 app_type 可以定义多个档案，每个档案持有**独立的、
//! 有序的** provider 列表。一个终端会话绑定到一个档案后，其 P1→P2→… 链就是该档案
//! 的成员序列，与其它终端互不影响。
//!
//! 默认档案是**虚拟的**（`profile_id = NULL`）：它映射到既有的共享队列
//! （providers.in_failover_queue = 1 的有序集合）。保留默认档案使旧的
//! `select_providers` / `add_to_failover_queue` 等路径 100% 不变（零回归）。
//!
//! 数据安全：本模块只 INSERT / UPDATE / DELETE 档案与其成员关系行，
//! **从不删除 providers 表的任何行**。删除档案时只清除成员关系行与档案自身行。

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use serde::{Deserialize, Serialize};

/// 故障转移路由档案
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailoverProfile {
    /// 档案 id；`None` 表示虚拟默认档案（映射到既有共享队列）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    pub app_type: String,
    pub name: String,
    pub sort_index: Option<usize>,
    pub member_count: usize,
}

/// 档案成员（有序）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailoverProfileMember {
    pub provider_id: String,
    pub provider_name: String,
    pub sort_index: Option<usize>,
}

impl Database {
    /// 列出某应用的所有档案（含虚拟默认档案，置于首位）。
    ///
    /// 默认档案的 `member_count` 取自共享队列
    /// （providers.in_failover_queue = 1）。
    pub fn list_failover_profiles(&self, app_type: &str) -> Result<Vec<FailoverProfile>, AppError> {
        let conn = lock_conn!(self.conn);

        // 默认档案成员数 = 共享队列长度
        let default_count: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM providers
                 WHERE app_type = ?1 AND in_failover_queue = 1",
                [app_type],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let mut profiles = vec![FailoverProfile {
            profile_id: None,
            app_type: app_type.to_string(),
            name: "默认档案".to_string(),
            sort_index: Some(0),
            member_count: default_count,
        }];

        let mut stmt = conn
            .prepare(
                "SELECT id, name, sort_index,
                        (SELECT COUNT(*) FROM failover_profile_members m
                         WHERE m.profile_id = failover_profiles.id
                           AND m.app_type = failover_profiles.app_type) AS member_count
                 FROM failover_profiles
                 WHERE app_type = ?1
                 ORDER BY COALESCE(sort_index, 999999), id ASC",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;

        let rows = stmt
            .query_map([app_type], |row| {
                Ok(FailoverProfile {
                    profile_id: Some(row.get(0)?),
                    app_type: app_type.to_string(),
                    name: row.get(1)?,
                    sort_index: row.get(2)?,
                    member_count: row.get(3)?,
                })
            })
            .map_err(|e| AppError::Database(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::Database(e.to_string()))?;

        profiles.extend(rows);
        Ok(profiles)
    }

    /// 该应用是否定义了任意命名档案（决定按终端路由走档案模式还是默认偏移模式）。
    pub fn app_has_failover_profiles(&self, app_type: &str) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let count: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM failover_profiles WHERE app_type = ?1",
                [app_type],
                |row| row.get(0),
            )
            .unwrap_or(0);
        Ok(count > 0)
    }

    /// 按档案 id 反查其所属 app_type（「档案即端点」用）。
    ///
    /// `/p/<profile_id>` 端点在路由层是 app 无关的：同一个前缀既可能承载 claude 的
    /// `/v1/messages`，也可能承载 codex 的 `/v1/responses`。而档案主键是
    /// `(id, app_type)`，一个 id 只归属一个 app，因此可由 id 唯一反查。
    /// 档案不存在时返回 `None`（调用方据此报错，而非静默退化到全局供应商）。
    pub fn failover_profile_app_type(&self, profile_id: &str) -> Result<Option<String>, AppError> {
        let conn = lock_conn!(self.conn);
        conn.query_row(
            "SELECT app_type FROM failover_profiles WHERE id = ?1 LIMIT 1",
            [profile_id],
            |row| row.get::<_, String>(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(AppError::Database(other.to_string())),
        })
    }

    /// 该档案是否存在于给定 app 之下（显式档案路由的归属校验）。
    pub fn failover_profile_exists(
        &self,
        app_type: &str,
        profile_id: &str,
    ) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let count: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM failover_profiles WHERE id = ?1 AND app_type = ?2",
                rusqlite::params![profile_id, app_type],
                |row| row.get(0),
            )
            .map_err(AppError::from)?;
        Ok(count > 0)
    }

    /// 创建新档案，返回档案 id。
    pub fn create_failover_profile(
        &self,
        app_type: &str,
        name: &str,
    ) -> Result<String, AppError> {
        let conn = lock_conn!(self.conn);
        let id = uuid::Uuid::new_v4().to_string();
        let sort_index: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(COALESCE(sort_index, 0)), 0) + 1
                 FROM failover_profiles WHERE app_type = ?1",
                [app_type],
                |row| row.get(0),
            )
            .unwrap_or(1);
        conn.execute(
            "INSERT INTO failover_profiles (id, app_type, name, sort_index, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, app_type, name, sort_index, now_ms()],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(id)
    }

    /// 重命名档案（不影响默认档案）。
    pub fn rename_failover_profile(
        &self,
        app_type: &str,
        profile_id: &str,
        new_name: &str,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "UPDATE failover_profiles SET name = ?1 WHERE id = ?2 AND app_type = ?3",
            rusqlite::params![new_name, profile_id, app_type],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// 删除档案（仅清除成员关系行 + 档案自身行；**不删 providers 行**）。
    pub fn delete_failover_profile(
        &self,
        app_type: &str,
        profile_id: &str,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM failover_profile_members WHERE profile_id = ?1 AND app_type = ?2",
            rusqlite::params![profile_id, app_type],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        conn.execute(
            "DELETE FROM failover_profiles WHERE id = ?1 AND app_type = ?2",
            rusqlite::params![profile_id, app_type],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// 获取档案成员（有序）。`profile_id = None` 表示默认档案（共享队列）。
    pub fn get_failover_profile_members(
        &self,
        app_type: &str,
        profile_id: Option<&str>,
    ) -> Result<Vec<FailoverProfileMember>, AppError> {
        let conn = lock_conn!(self.conn);
        match profile_id {
            None => {
                let mut stmt = conn
                    .prepare(
                        "SELECT p.id, p.name, p.sort_index
                         FROM providers p
                         WHERE p.app_type = ?1 AND p.in_failover_queue = 1
                         ORDER BY COALESCE(p.sort_index, 999999), p.id ASC",
                    )
                    .map_err(|e| AppError::Database(e.to_string()))?;
                let rows = stmt
                    .query_map([app_type], |row| {
                        Ok(FailoverProfileMember {
                            provider_id: row.get(0)?,
                            provider_name: row.get(1)?,
                            sort_index: row.get(2)?,
                        })
                    })
                    .map_err(|e| AppError::Database(e.to_string()))?;
                let items = rows
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| AppError::Database(e.to_string()))?;
                Ok(items)
            }
            Some(pid) => {
                let mut stmt = conn
                    .prepare(
                        "SELECT m.provider_id, p.name, m.sort_index
                         FROM failover_profile_members m
                         JOIN providers p
                           ON p.id = m.provider_id AND p.app_type = m.app_type
                         WHERE m.profile_id = ?1 AND m.app_type = ?2
                         ORDER BY COALESCE(m.sort_index, 999999), m.provider_id ASC",
                    )
                    .map_err(|e| AppError::Database(e.to_string()))?;
                let rows = stmt
                    .query_map(rusqlite::params![pid, app_type], |row| {
                        Ok(FailoverProfileMember {
                            provider_id: row.get(0)?,
                            provider_name: row.get(1)?,
                            sort_index: row.get(2)?,
                        })
                    })
                    .map_err(|e| AppError::Database(e.to_string()))?;
                let items = rows
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| AppError::Database(e.to_string()))?;
                Ok(items)
            }
        }
    }

    /// 获取档案成员的 provider id 有序列表（路由读取热路径用，轻量）。
    pub fn get_failover_profile_member_ids(
        &self,
        app_type: &str,
        profile_id: Option<&str>,
    ) -> Result<Vec<String>, AppError> {
        Ok(self
            .get_failover_profile_members(app_type, profile_id)?
            .into_iter()
            .map(|m| m.provider_id)
            .collect())
    }

    /// 添加 provider 到档案。同一 provider 可同时存在于多个档案与默认队列中
    /// （不同档案是独立链）。sort_index 取当前最大值 +1。
    pub fn add_provider_to_failover_profile(
        &self,
        app_type: &str,
        profile_id: &str,
        provider_id: &str,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        let next_sort: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(COALESCE(sort_index, 0)), 0) + 1
                 FROM failover_profile_members
                 WHERE profile_id = ?1 AND app_type = ?2",
                rusqlite::params![profile_id, app_type],
                |row| row.get(0),
            )
            .unwrap_or(1);
        conn.execute(
            "INSERT OR IGNORE INTO failover_profile_members
                (profile_id, app_type, provider_id, sort_index)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![profile_id, app_type, provider_id, next_sort],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// 从档案移除 provider（仅删成员关系行，**不删 providers 行**）。
    pub fn remove_provider_from_failover_profile(
        &self,
        app_type: &str,
        profile_id: &str,
        provider_id: &str,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM failover_profile_members
             WHERE profile_id = ?1 AND app_type = ?2 AND provider_id = ?3",
            rusqlite::params![profile_id, app_type, provider_id],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// 整体重置档案成员顺序（前端拖拽重排后提交全量有序 provider_id 列表）。
    pub fn reorder_failover_profile_members(
        &self,
        app_type: &str,
        profile_id: &str,
        ordered_provider_ids: &[String],
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        let tx = conn.unchecked_transaction().map_err(|e| AppError::Database(e.to_string()))?;
        tx.execute(
            "DELETE FROM failover_profile_members WHERE profile_id = ?1 AND app_type = ?2",
            rusqlite::params![profile_id, app_type],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        for (idx, pid) in ordered_provider_ids.iter().enumerate() {
            tx.execute(
                "INSERT INTO failover_profile_members
                    (profile_id, app_type, provider_id, sort_index)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![profile_id, app_type, pid, idx as i64],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        }
        tx.commit().map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// 删除某应用下所有档案（SQL 导入 / 总开关关闭时清理用；仅清档案+成员关系行，
    /// 不删 providers 行）。
    pub fn clear_failover_profiles_for_app(&self, app_type: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM failover_profile_members WHERE app_type = ?1",
            [app_type],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        conn.execute(
            "DELETE FROM failover_profiles WHERE app_type = ?1",
            [app_type],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
