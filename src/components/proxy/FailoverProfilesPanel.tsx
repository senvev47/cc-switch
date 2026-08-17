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
  SquareTerminal,
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
import { failoverProfilesApi } from "@/lib/api/failoverProfiles";
import {
  useFailoverProfiles,
  useFailoverProfileMembers,
  useCreateFailoverProfile,
  useRenameFailoverProfile,
  useDeleteFailoverProfile,
  useAddProviderToFailoverProfile,
  useRemoveProviderFromFailoverProfile,
  useReorderFailoverProfileMembers,
  toNamedFailoverProfiles,
} from "@/lib/query/failoverProfiles";
import { useAvailableProvidersForFailover } from "@/lib/query/failover";
import { FailoverPriorityBadge } from "@/components/providers/FailoverPriorityBadge";
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
  /** 正在打开终端的档案 id（用于按钮 loading / 禁用）。 */
  const [openingTerminalId, setOpeningTerminalId] = useState<string | null>(
    null,
  );

  const { data: profiles, isLoading: profilesLoading } =
    useFailoverProfiles(appType);
  // 与供应商卡片上的档案徽章共用同一份排序与配色索引
  const namedProfiles = useMemo(
    () => toNamedFailoverProfiles(profiles),
    [profiles],
  );

  // 加载按终端路由配置（用于「新终端使用哪个档案」预设）。
  useEffect(() => {
    settingsApi
      .getPerTerminalRoutingConfig()
      .then(setRoutingConfig)
      .catch((e) => console.error("Failed to load routing config:", e));
  }, []);

  /** 当前应用的「新终端使用哪个档案」预设（缺省 = 默认共享队列）。 */
  const nextProfileIdForApp =
    routingConfig?.nextNewTerminalProfileIdByApp?.[appType] ?? null;

  const handleSetNextProfile = async (profileId: string | null) => {
    if (!routingConfig) return;
    // 只改当前 appType 的键，保留其它应用的预设
    const byApp = { ...(routingConfig.nextNewTerminalProfileIdByApp ?? {}) };
    if (profileId) {
      byApp[appType] = profileId;
    } else {
      delete byApp[appType];
    }
    const next: PerTerminalRoutingConfig = {
      ...routingConfig,
      nextNewTerminalProfileIdByApp: byApp,
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
              "已设为新终端的档案（保持，直到你手动更改）",
            )
          : t(
              "proxy.failoverProfiles.presetCleared",
              "已设为默认共享队列（保持，直到你手动更改）",
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

  /** 打开一个绑定到该档案的终端：先选工作目录，再调用后端。 */
  const handleOpenTerminal = async (profileId: string) => {
    if (openingTerminalId) return;
    let cwd: string | null = null;
    try {
      cwd = await settingsApi.pickDirectory();
    } catch (error) {
      toast.error(
        t("proxy.failoverProfiles.openTerminalFailed", "打开终端失败") +
          ": " +
          String(error),
      );
      return;
    }
    // 用户取消选择目录 → 静默中止
    if (!cwd) return;
    // 可选：恢复指定会话。留空=新会话。
    const resumeSession = window.prompt(
      t(
        "proxy.failoverProfiles.resumeSessionPrompt",
        "可选：恢复会话 ID（留空=新会话）。claude 用 `-r <id>`，codex 用 `resume <id>`。",
      ),
      "",
    );
    setOpeningTerminalId(profileId);
    try {
      await failoverProfilesApi.openProfileTerminal(
        appType,
        profileId,
        cwd,
        resumeSession ?? undefined,
      );
      toast.success(
        t("proxy.failoverProfiles.openTerminalSuccess", "已打开绑定该档案的终端"),
        { closeButton: true },
      );
    } catch (error) {
      toast.error(
        t("proxy.failoverProfiles.openTerminalFailed", "打开终端失败") +
          ": " +
          String(error),
      );
    } finally {
      setOpeningTerminalId(null);
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
                  "新终端使用",
                )}
              </span>
              <p className="text-xs text-muted-foreground">
                {t(
                  "proxy.failoverProfiles.nextNewTerminalHint",
                  "设好后，每个新接入的终端都会绑定到该档案，直到你手动更改。已开的终端不受影响。",
                )}
              </p>
            </div>
            <Select
              value={nextProfileIdForApp ?? "__default__"}
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
                  <SelectItem key={p.profileId} value={p.profileId}>
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
                    onClick={() => setActiveProfileId(p.profileId)}
                    className="flex-1 min-w-0 text-left"
                  >
                    {renamingId === p.profileId ? (
                      <Input
                        value={renameValue}
                        autoFocus
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => handleRename(p.profileId)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleRename(p.profileId);
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
                        {p.port != null && (
                          <span
                            className="px-1.5 py-0.5 text-[10px] rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 font-mono"
                            title={t(
                              "proxy.failoverProfiles.portTitle",
                              "该档案独占的代理端口",
                            )}
                          >
                            :{p.port}
                          </span>
                        )}
                      </div>
                    )}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => handleOpenTerminal(p.profileId)}
                    disabled={disabled || openingTerminalId !== null}
                    aria-label="open terminal"
                    title={t(
                      "proxy.failoverProfiles.openTerminal",
                      "打开绑定该档案的终端（先选择工作目录）",
                    )}
                  >
                    {openingTerminalId === p.profileId ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <SquareTerminal className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => {
                      setRenamingId(p.profileId);
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
                    onClick={() => handleDelete(p.profileId)}
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
                            <FailoverPriorityBadge
                              priority={idx + 1}
                              colorIndex={p.colorIndex}
                              profileName={p.name}
                            />
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
