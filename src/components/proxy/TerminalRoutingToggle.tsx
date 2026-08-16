/**
 * 「终端路由」开关 + 档案切换器（放在顶部工具栏，紧邻 FailoverToggle）。
 *
 * - 开关：读写 `PerTerminalRoutingConfig.enabled`（后端开关默认关闭）。
 * - 档案下拉：列出该应用的命名档案，点击某档案 = 为该档案开一个专属端口终端
 *   （`open_profile_terminal` → `start_profile_server` → `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`）。
 *   不同档案 = 不同端口 = 不同 baseUrl，claude code gateway 缓存按 baseUrl 隔离，互不串扰。
 *   已运行终端的 baseUrl/cwd 不可切换，所以每次切换都是开一个新终端（符合 D盘/C盘 不可互切约束）。
 *
 * 该组件取代早期放在 ProviderList 上方的 ProfileSwitcherBar。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loader2, Network } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { settingsApi } from "@/lib/api/settings";
import { failoverProfilesApi } from "@/lib/api/failoverProfiles";
import {
  useFailoverProfiles,
  toNamedFailoverProfiles,
} from "@/lib/query/failoverProfiles";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import type { AppId } from "@/lib/api";

interface TerminalRoutingToggleProps {
  className?: string;
  activeApp: AppId;
}

const ROUTING_CONFIG_KEY = ["per-terminal-routing-config"] as const;

export function TerminalRoutingToggle({
  className,
  activeApp,
}: TerminalRoutingToggleProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: profiles } = useFailoverProfiles(activeApp);
  const named = toNamedFailoverProfiles(profiles);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const { data: config } = useQuery({
    queryKey: ROUTING_CONFIG_KEY,
    queryFn: () => settingsApi.getPerTerminalRoutingConfig(),
  });

  const enabled = config?.enabled ?? false;
  const currentPreset = config?.nextNewTerminalProfileIdByApp?.[activeApp];

  const handleToggle = async (checked: boolean) => {
    try {
      await settingsApi.setPerTerminalRoutingConfig({
        enabled: checked,
        nextNewTerminalProfileIdByApp:
          config?.nextNewTerminalProfileIdByApp ?? null,
      });
      queryClient.invalidateQueries({ queryKey: ROUTING_CONFIG_KEY });
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleSelectProfile = async (profileId: string) => {
    // profileId === "__default__" 表示默认共享队列（主端口，不开档案终端）。
    if (openingId) return;
    if (profileId === "__default__") {
      // 记录预设为默认（主端口共享队列），不打开终端。
      try {
        const next = { ...(config?.nextNewTerminalProfileIdByApp ?? {}) };
        delete next[activeApp];
        await settingsApi.setPerTerminalRoutingConfig({
          enabled,
          nextNewTerminalProfileIdByApp: next,
        });
        queryClient.invalidateQueries({ queryKey: ROUTING_CONFIG_KEY });
      } catch (e) {
        toast.error(String(e));
      }
      return;
    }
    // 选中某命名档案 → 开一个该档案专属端口的终端。
    let cwd: string | null = null;
    try {
      cwd = await settingsApi.pickDirectory();
    } catch (e) {
      toast.error(
        t("proxy.failoverProfiles.openTerminalFailed", "打开终端失败") +
          ": " +
          String(e),
      );
      return;
    }
    if (!cwd) return;
    setOpeningId(profileId);
    try {
      await failoverProfilesApi.openProfileTerminal(activeApp, profileId, cwd);
      toast.success(
        t("proxy.failoverProfiles.openTerminalSuccess", "已打开绑定该档案的终端"),
        { closeButton: true },
      );
    } catch (e) {
      toast.error(
        t("proxy.failoverProfiles.openTerminalFailed", "打开终端失败") +
          ": " +
          String(e),
      );
    } finally {
      setOpeningId(null);
    }
  };

  // 没有命名档案时不显示档案下拉，但开关仍显示（用户可先去创建档案）。
  const selectValue = currentPreset ?? "__default__";

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-1.5 h-8 rounded-lg bg-muted/50 transition-all",
        className,
      )}
      title={t(
        "settings.advanced.perTerminalRouting.enabledDescription",
        "开启后，不同终端可绑定不同的故障转移链。",
      )}
    >
      <Network
        className={cn(
          "h-4 w-4 transition-colors",
          enabled ? "text-sky-500" : "text-muted-foreground",
        )}
      />
      <Switch checked={enabled} onCheckedChange={handleToggle} />
      {named.length > 0 && (
        <Select value={selectValue} onValueChange={handleSelectProfile}>
          <SelectTrigger className="h-7 w-[150px] text-xs gap-1 border-none bg-transparent shadow-none focus:ring-0 px-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">
              {t("proxy.failoverProfiles.defaultProfile", "默认（共享队列）")}
            </SelectItem>
            {named.map((p) => (
              <SelectItem key={p.profileId} value={p.profileId}>
                <span className="inline-flex items-center gap-1.5">
                  {openingId === p.profileId && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  )}
                  <span className="max-w-[120px] truncate">{p.name}</span>
                  {p.port != null && (
                    <span className="font-mono text-[10px] text-blue-600 dark:text-blue-400">
                      :{p.port}
                    </span>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
