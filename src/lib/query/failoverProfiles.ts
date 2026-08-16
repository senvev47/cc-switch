import {
  useQuery,
  useQueries,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { failoverProfilesApi } from "@/lib/api/failoverProfiles";
import type {
  FailoverProfile,
  FailoverProfileMember,
} from "@/lib/api/failoverProfiles";

/** Query keys for failover profiles. */
export const failoverProfileKeys = {
  all: ["failoverProfiles"] as const,
  list: (appType: string) => ["failoverProfiles", "list", appType] as const,
  members: (appType: string, profileId: string | null) =>
    ["failoverProfiles", "members", appType, profileId ?? "__default__"] as const,
};

/** 命名档案（已排除虚拟默认档案），带稳定配色索引。 */
export interface NamedFailoverProfile {
  profileId: string;
  name: string;
  memberCount: number;
  /** 稳定配色索引 = 按 sortIndex（并列时按 profileId）排序后的位次。 */
  colorIndex: number;
}

/**
 * 把 listProfiles 的结果规约为「命名档案 + 稳定配色索引」。
 *
 * 唯一的配色索引来源：供应商卡片徽章与档案面板序号都走这里，
 * 因此同一档案在两处必然同色；配色只随 sortIndex 变化，不随渲染顺序变化。
 */
export function toNamedFailoverProfiles(
  profiles: FailoverProfile[] | undefined,
): NamedFailoverProfile[] {
  return (profiles ?? [])
    .filter((p) => !!p.profileId)
    .slice()
    .sort((a, b) => {
      const ai = a.sortIndex ?? Number.MAX_SAFE_INTEGER;
      const bi = b.sortIndex ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      // sortIndex 缺省/并列时退化为按 id 的稳定顺序
      return (a.profileId ?? "").localeCompare(b.profileId ?? "");
    })
    .map((p, idx) => ({
      profileId: p.profileId!,
      name: p.name,
      memberCount: p.memberCount,
      colorIndex: idx,
    }));
}

/** 列出某应用的所有档案（含虚拟默认档案）。 */
export function useFailoverProfiles(appType: string) {
  return useQuery({
    queryKey: failoverProfileKeys.list(appType),
    queryFn: () => failoverProfilesApi.listProfiles(appType),
    enabled: !!appType,
  });
}

/** 获取档案成员（有序）。profileId=null → 默认档案（共享队列）。 */
export function useFailoverProfileMembers(
  appType: string,
  profileId: string | null,
) {
  return useQuery({
    queryKey: failoverProfileKeys.members(appType, profileId),
    queryFn: () => failoverProfilesApi.getMembers(appType, profileId),
    enabled: !!appType,
  });
}

/**
 * 批量获取多个档案的成员（每个档案一个查询）。
 *
 * queryKey 与 `useFailoverProfileMembers` 完全一致，因此与单档案查询共用缓存，
 * 成员增删/重排后的 invalidate 会同时刷新这里（供应商卡片上的档案徽章）。
 * 返回数组与 `profileIds` 同序，未加载完成的项为 undefined。
 */
export function useFailoverProfileMembersMany(
  appType: string,
  profileIds: string[],
) {
  return useQueries({
    queries: profileIds.map((profileId) => ({
      queryKey: failoverProfileKeys.members(appType, profileId),
      queryFn: () => failoverProfilesApi.getMembers(appType, profileId),
      enabled: !!appType && !!profileId,
    })),
    combine: (results) => results.map((r) => r.data),
  });
}

/** 创建新档案，返回档案 id。 */
export function useCreateFailoverProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      appType,
      name,
    }: {
      appType: string;
      name: string;
    }) => failoverProfilesApi.createProfile(appType, name),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: failoverProfileKeys.list(variables.appType),
      });
    },
  });
}

/** 重命名档案。 */
export function useRenameFailoverProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      appType,
      profileId,
      newName,
    }: {
      appType: string;
      profileId: string;
      newName: string;
    }) => failoverProfilesApi.renameProfile(appType, profileId, newName),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: failoverProfileKeys.list(variables.appType),
      });
    },
  });
}

/** 删除档案（仅清档案与成员关系行，不删 providers 行）。 */
export function useDeleteFailoverProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      appType,
      profileId,
    }: {
      appType: string;
      profileId: string;
    }) => failoverProfilesApi.deleteProfile(appType, profileId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: failoverProfileKeys.list(variables.appType),
      });
      // 删除档案会触发后端 clear_app_session_routes，会话绑定已失效；
      // 其它档案成员查询不受影响，无需逐个失效。
    },
  });
}

/** 添加 provider 到档案。 */
export function useAddProviderToFailoverProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      appType,
      profileId,
      providerId,
    }: {
      appType: string;
      profileId: string;
      providerId: string;
    }) =>
      failoverProfilesApi.addProvider(appType, profileId, providerId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: failoverProfileKeys.members(
          variables.appType,
          variables.profileId,
        ),
      });
      queryClient.invalidateQueries({
        queryKey: failoverProfileKeys.list(variables.appType),
      });
    },
  });
}

/** 从档案移除 provider。 */
export function useRemoveProviderFromFailoverProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      appType,
      profileId,
      providerId,
    }: {
      appType: string;
      profileId: string;
      providerId: string;
    }) =>
      failoverProfilesApi.removeProvider(appType, profileId, providerId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: failoverProfileKeys.members(
          variables.appType,
          variables.profileId,
        ),
      });
      queryClient.invalidateQueries({
        queryKey: failoverProfileKeys.list(variables.appType),
      });
    },
  });
}

/** 重排档案成员顺序。 */
export function useReorderFailoverProfileMembers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      appType,
      profileId,
      orderedProviderIds,
    }: {
      appType: string;
      profileId: string;
      orderedProviderIds: string[];
    }) =>
      failoverProfilesApi.reorderMembers(
        appType,
        profileId,
        orderedProviderIds,
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: failoverProfileKeys.members(
          variables.appType,
          variables.profileId,
        ),
      });
    },
  });
}

export type { FailoverProfile, FailoverProfileMember };
