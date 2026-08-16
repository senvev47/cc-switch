import { invoke } from "@tauri-apps/api/core";

export interface FailoverProfile {
  profileId?: string; // undefined = 虚拟默认档案（共享队列）
  appType: string;
  name: string;
  sortIndex?: number;
  memberCount: number;
  /** 「档案即端口」：该档案独占的代理端口（虚拟默认档案为 undefined = 主端口）。 */
  port?: number;
}

export interface FailoverProfileMember {
  providerId: string;
  providerName: string;
  sortIndex?: number;
}

export const failoverProfilesApi = {
  async listProfiles(appType: string): Promise<FailoverProfile[]> {
    return invoke("list_failover_profiles", { appType });
  },

  async createProfile(appType: string, name: string): Promise<string> {
    return invoke("create_failover_profile", { appType, name });
  },

  async renameProfile(
    appType: string,
    profileId: string,
    newName: string,
  ): Promise<void> {
    return invoke("rename_failover_profile", {
      appType,
      profileId,
      newName,
    });
  },

  async deleteProfile(appType: string, profileId: string): Promise<void> {
    return invoke("delete_failover_profile", { appType, profileId });
  },

  async getMembers(
    appType: string,
    profileId: string | null,
  ): Promise<FailoverProfileMember[]> {
    // profileId = null/undefined/"" 都映射到默认档案
    const pid =
      profileId && profileId.length > 0 ? profileId : null;
    return invoke("get_failover_profile_members", { appType, profileId: pid });
  },

  async addProvider(
    appType: string,
    profileId: string,
    providerId: string,
  ): Promise<void> {
    return invoke("add_provider_to_failover_profile", {
      appType,
      profileId,
      providerId,
    });
  },

  async removeProvider(
    appType: string,
    profileId: string,
    providerId: string,
  ): Promise<void> {
    return invoke("remove_provider_from_failover_profile", {
      appType,
      profileId,
      providerId,
    });
  },

  async reorderMembers(
    appType: string,
    profileId: string,
    orderedProviderIds: string[],
  ): Promise<void> {
    return invoke("reorder_failover_profile_members", {
      appType,
      profileId,
      orderedProviderIds,
    });
  },

  /** 打开一个绑定到该命名档案的终端。cwd 缺省时由后端决定工作目录。 */
  async openProfileTerminal(
    appType: string,
    profileId: string,
    cwd?: string,
  ): Promise<void> {
    return invoke("open_profile_terminal", {
      app: appType,
      profileId,
      cwd,
    });
  },
};
