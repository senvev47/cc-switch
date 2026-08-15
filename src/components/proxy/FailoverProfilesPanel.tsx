/**
 * 命名故障转移路由档案管理（Feature #2 升级：每终端独立故障转移队列）
 *
 * 允许用户为一个应用定义多个命名档案，每个档案持有独立的、有序的供应商列表。
 * 开启按终端路由后，新开终端会按 rotate/reuse 策略绑定到一个档案，使不同终端
 * 各自走独立的故障转移链路（而不只是共享队列的不同起点）。
 *
 * 默认档案（profile_id=null）即既有的共享故障转移队列，仍由上方的
 * FailoverQueueManager 管理；此处只管理命名档案。
 */

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Loader2,
  FolderPlus,
  Pencil,
  ArrowUp,
  ArrowDown,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { AppId } from "@/lib/api";
import {
  useFailoverProfiles,
  useFailoverProfileMembers,
  useCreateFailoverProfile,
  useRenameFailoverProfile,
  useDeleteFailoverProfile,
  useAddProviderToFailoverProfile,
  useRemoveProviderFromFailoverProfile,
  useReorderFailoverProfileMembers,
} from "@/lib/query/failoverProfiles";
import { useAvailableProvidersForFailover } from "@/lib/query/failover";
import { settingsApi, type PerTerminalRoutingConfig } from "@/lib/api/settings";

interface FailoverProfilesPanelProps {
  appType: AppId;
  disabled?: boolean;
}

export function FailoverProfilesPanel({
  appType,
  disabled = false,
}: FailoverProfilesPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [newProfileName, setNewProfileName] = useState("");
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [routingConfig, setRoutingConfig] = useState<PerTerminalRoutingConfig | null>(
    null,
  );
  const [savingPreset, setSavingPreset] = useState(false);

  const { data: profiles, isLoading: profilesLoading } =
    useFailoverProfiles(appType);
  const namedProfiles = useMemo(
    () => (profiles ?? []).filter((p) => !!p.profileId),
    [profiles],
  );

  // 加载按终端路由配置（用于「下一个新终端使用哪个档案」预设）。
  useEffect(() => {
    settingsApi
      .getPerTerminalRoutingConfig()
      .then(setRoutingConfig)
      .catch((e) => console.error("Failed to load routing config:", e));
  }, []);

  const handleSetNextProfile = async (profileId: string | null) => {
    if (!routingConfig) return;
    const next: PerTerminalRoutingConfig = {
      ...routingConfig,
      nextNewTerminalProfileId: profileId,
    };
    setSavingPreset(true);
    try {
      await settingsApi.setPerTerminalRoutingConfig(next);
      setRoutingConfig(next);
      queryClient.invalidateQueries({ queryKey: ["perTerminalRoutingConfig"] });
      toast.success(
        profileId
          ? t(
              "proxy.failoverProfiles.presetSet",
              "已设为下一个新终端的档案（仅生效一次）",
            )
          : t(
              "proxy.failoverProfiles.presetCleared",
              "已清除预设，下一个新终端将走默认共享队列",
            ),
        { closeButton: true },
      );
    } catch (e) {
      toast.error(
        t("proxy.failoverProfiles.presetFailed", "设置预设失败") + ": " + String(e),
      );
    } finally {
      setSavingPreset(false);
    }
  };

  // 自动选中第一个档案（若尚未选中）。
  const effectiveActive =
    activeProfileId ?? namedProfiles[0]?.profileId ?? null;

  const { data: members, isLoading: membersLoading } =
    useFailoverProfileMembers(appType, effectiveActive);
  const { data: availableProviders } =
    useAvailableProvidersForFailover(appType);

  const createProfile = useCreateFailoverProfile();
  const renameProfile = useRenameFailoverProfile();
  const deleteProfile = useDeleteFailoverProfile();
  const addProvider = useAddProviderToFailoverProfile();
  const removeProvider = useRemoveProviderFromFailoverProfile();
  const reorderMembers = useReorderFailoverProfileMembers();

  const handleCreate = async () => {
    const name = newProfileName.trim();
    if (!name) return;
    try {
      const id = await createProfile.mutateAsync({ appType, name });
      setNewProfileName("");
      setActiveProfileId(id);
      toast.success(
        t("proxy.failoverProfiles.createSuccess", "已创建档案"),
        { closeButton: true },
      );
    } catch (error) {
      toast.error(
        t("proxy.failoverProfiles.createFailed", "创建档案失败") +
          ": " +
          String(error),
      );
    }
  };

  const handleRename = async (profileId: string) => {
    const name = renameValue.trim();
    if (!name) {
      setRenamingId(null);
      return;
    }
    try {
      await renameProfile.mutateAsync({ appType, profileId, newName: name });
      setRenamingId(null);
      toast.success(
        t("proxy.failoverProfiles.renameSuccess", "已重命名档案"),
        { closeButton: true },
      );
    } catch (error) {
      toast.error(
        t("proxy.failoverProfiles.renameFailed", "重命名失败") +
          ": " +
          String(error),
      );
    }
  };

  const handleDelete = async (profileId: string) => {
    if (
      !window.confirm(
        t(
          "proxy.failoverProfiles.confirmDelete",
          "删除该档案？仅清除档案与其成员关系，不会删除供应商本身。",
        ),
      )
    )
      return;
    try {
      await deleteProfile.mutateAsync({ appType, profileId });
      if (activeProfileId === profileId) setActiveProfileId(null);
      toast.success(
        t("proxy.failoverProfiles.deleteSuccess", "已删除档案"),
        { closeButton: true },
      );
    } catch (error) {
      toast.error(
        t("proxy.failoverProfiles.deleteFailed", "删除失败") +
          ": " +
          String(error),
      );
    }
  };

  const handleAddProvider = async () => {
    if (!effectiveActive || !selectedProviderId) return;
    try {
      await addProvider.mutateAsync({
        appType,
        profileId: effectiveActive,
        providerId: selectedProviderId,
      });
      setSelectedProviderId("");
      toast.success(
        t("proxy.failoverProfiles.addProviderSuccess", "已加入档案"),
        { closeButton: true },
      );
    } catch (error) {
      toast.error(
        t("proxy.failoverProfiles.addProviderFailed", "添加失败") +
          ": " +
          String(error),
      );
    }
  };

  const handleRemoveProvider = async (providerId: string) => {
    if (!effectiveActive) return;
    try {
      await removeProvider.mutateAsync({
        appType,
        profileId: effectiveActive,
        providerId,
      });
    } catch (error) {
      toast.error(
        t("proxy.failoverProfiles.removeProviderFailed", "移除失败") +
          ": " +
          String(error),
      );
    }
  };

  const handleMove = async (idx: number, dir: -1 | 1) => {
    if (!effectiveActive || !members) return;
    const next = [...members];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    try {
      await reorderMembers.mutateAsync({
        appType,
        profileId: effectiveActive,
        orderedProviderIds: next.map((m) => m.providerId),
      });
    } catch (error) {
      toast.error(
        t("proxy.failoverProfiles.reorderFailed", "重排失败") +
          ": " +
          String(error),
      );
    }
  };

  return (
    <div className="space-y-3">
      <Alert className="border-violet-500/40 bg-violet-500/10">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription className="text-xs">
          {t(
            "proxy.failoverProfiles.intro",
            "命名档案让每个终端走独立的故障转移链路。上方「自动故障转移队列」是默认档案（所有终端共享）。定义任意命名档案后，开启按终端路由即可让新终端按策略绑定到不同档案。",
          )}
        </AlertDescription>
      </Alert>

      {/* 下一个新终端的档案预设（一次性） */}
      {routingConfig?.enabled && (
        <div className="rounded-lg border border-violet-500/40 bg-violet-500/5 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5 min-w-0">
              <span className="text-sm font-medium">
                {t(
                  "proxy.failoverProfiles.nextNewTerminal",
                  "下一个新终端使用",
                )}
              </span>
              <p className="text-xs text-muted-foreground">
                {t(
                  "proxy.failoverProfiles.nextNewTerminalHint",
                  "设好后，下一个新接入的终端会绑定到该档案，绑定后预设自动清回默认。",
                )}
              </p>
            </div>
            <Select
              value={
                routingConfig.nextNewTerminalProfileId
                  ? routingConfig.nextNewTerminalProfileId
                  : "__default__"
              }
              onValueChange={(v) =>
                handleSetNextProfile(v === "__default__" ? null : v)
              }
              disabled={
                disabled || savingPreset || namedProfiles.length === 0
              }
            >
              <SelectTrigger className="w-[180px] shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">
                  {t(
                    "proxy.failoverProfiles.useDefaultQueue",
                    "默认共享队列",
                  )}
                </SelectItem>
                {namedProfiles.map((p) => (
                  <SelectItem key={p.profileId} value={p.profileId!}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {/* 创建档案 */}
      <div className="flex items-center gap-2">
        <Input
          value={newProfileName}
          onChange={(e) => setNewProfileName(e.target.value)}
          placeholder={t(
            "proxy.failoverProfiles.newNamePlaceholder",
            "新档案名称（如：备用链路 / 高并发组）",
          )}
          disabled={disabled || createProfile.isPending}
          className="flex-1"
          onKeyDown={(e) => {
            if (e.key === "Enter") handleCreate();
          }}
        />
        <Button
          onClick={handleCreate}
          disabled={disabled || !newProfileName.trim() || createProfile.isPending}
          size="sm"
          variant="outline"
        >
          {createProfile.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <FolderPlus className="h-4 w-4" />
          )}
          <span className="ml-1">
            {t("proxy.failoverProfiles.create", "新建档案")}
          </span>
        </Button>
      </div>

      {/* 档案列表 */}
      {profilesLoading ? (
        <div className="flex items-center justify-center p-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : namedProfiles.length === 0 ? (
        <div className="rounded-lg border border-dashed border-muted-foreground/40 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {t(
              "proxy.failoverProfiles.empty",
              "尚未创建命名档案。新建后即可让不同终端走独立链路。",
            )}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {namedProfiles.map((p) => {
            const isActive = p.profileId === effectiveActive;
            return (
              <div
                key={p.profileId}
                className={cn(
                  "rounded-lg border bg-card p-2 transition-colors",
                  isActive
                    ? "border-violet-500/60 bg-violet-500/5"
                    : "border-border/60",
                )}
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveProfileId(p.profileId!)}
                    className="flex-1 min-w-0 text-left"
                  >
                    {renamingId === p.profileId ? (
                      <Input
                        value={renameValue}
                        autoFocus
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => handleRename(p.profileId!)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleRename(p.profileId!);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        className="h-7"
                        disabled={renameProfile.isPending}
                      />
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">
                          {p.name}
                        </span>
                        <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-muted text-muted-foreground">
                          {p.memberCount}{" "}
                          {t("proxy.failoverProfiles.membersUnit", "家")}
                        </span>
                      </div>
                    )}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => {
                      setRenamingId(p.profileId!);
                      setRenameValue(p.name);
                    }}
                    disabled={disabled}
                    aria-label="rename"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => handleDelete(p.profileId!)}
                    disabled={disabled || deleteProfile.isPending}
                    aria-label="delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>

                {/* 活动档案的成员管理 */}
                {isActive && (
                  <div className="mt-2 space-y-2 border-t border-border/40 pt-2">
                    {/* 添加供应商 */}
                    <div className="flex items-center gap-2">
                      <Select
                        value={selectedProviderId}
                        onValueChange={setSelectedProviderId}
                        disabled={disabled || addProvider.isPending}
                      >
                        <SelectTrigger className="h-8 flex-1">
                          <SelectValue
                            placeholder={t(
                              "proxy.failoverProfiles.selectProvider",
                              "选择供应商加入此档案",
                            )}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {availableProviders?.map((provider) => (
                            <SelectItem
                              key={provider.id}
                              value={provider.id}
                            >
                              {provider.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        onClick={handleAddProvider}
                        disabled={
                          disabled || !selectedProviderId || addProvider.isPending
                        }
                        size="icon"
                        variant="outline"
                        className="h-8 w-8"
                      >
                        {addProvider.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Plus className="h-4 w-4" />
                        )}
                      </Button>
                    </div>

                    {/* 成员列表（有序，可上下移动） */}
                    {membersLoading ? (
                      <div className="flex justify-center py-2">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    ) : !members || members.length === 0 ? (
                      <p className="text-xs text-muted-foreground py-2 text-center">
                        {t(
                          "proxy.failoverProfiles.noMembers",
                          "该档案暂无成员",
                        )}
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {members.map((m, idx) => (
                          <div
                            key={m.providerId}
                            className="flex items-center gap-2 rounded border border-border/40 bg-background/40 px-2 py-1"
                          >
                            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-medium">
                              {idx + 1}
                            </span>
                            <span className="flex-1 text-xs truncate">
                              {m.providerName}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => handleMove(idx, -1)}
                              disabled={disabled || idx === 0}
                              aria-label="up"
                            >
                              <ArrowUp className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => handleMove(idx, 1)}
                              disabled={disabled || idx === members.length - 1}
                              aria-label="down"
                            >
                              <ArrowDown className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-muted-foreground hover:text-destructive"
                              onClick={() => handleRemoveProvider(m.providerId)}
                              disabled={disabled || removeProvider.isPending}
                              aria-label="remove"
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
