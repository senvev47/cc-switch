import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FolderOpen, Loader2, SquareTerminal } from "lucide-react";
import { failoverProfilesApi } from "@/lib/api/failoverProfiles";
import { settingsApi } from "@/lib/api/settings";
import {
  useFailoverProfiles,
  toNamedFailoverProfiles,
} from "@/lib/query/failoverProfiles";
import type { AppId } from "@/lib/api";

/**
 * 供应商列表上方的「档案快速切换」栏（「档案即端口」）。
 *
 * 每个命名档案一个按钮：点击 = 直接为该档案开一个绑定专属端口的终端
 * （`open_profile_terminal` 内部 `start_profile_server` 分配端口并写
 * `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`）。主端口 15721 的终端
 * 不再绑定任何命名档案，故不同档案的终端互不串扰。
 *
 * 工作目录：每次点击都让用户选一次（已运行终端的 cwd 无法切换——
 * D 盘终端不能切到 C 盘，反之亦然，所以每次新开终端都需要一个 cwd）。
 */
interface ProfileSwitcherBarProps {
  appType: AppId;
}

export function ProfileSwitcherBar({ appType }: ProfileSwitcherBarProps) {
  const { t } = useTranslation();
  const { data: profiles } = useFailoverProfiles(appType);
  const named = toNamedFailoverProfiles(profiles);
  const [openingId, setOpeningId] = useState<string | null>(null);

  if (named.length === 0) return null;

  const handleOpen = async (profileId: string) => {
    if (openingId) return;
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
    if (!cwd) return; // 用户取消
    setOpeningId(profileId);
    try {
      await failoverProfilesApi.openProfileTerminal(appType, profileId, cwd);
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
      setOpeningId(null);
    }
  };

  return (
    <div className="flex items-center gap-2 flex-wrap px-1">
      <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
        <SquareTerminal className="h-3.5 w-3.5" />
        {t("proxy.failoverProfiles.switcherTitle", "档案终端")}
      </span>
      {named.map((p) => (
        <button
          key={p.profileId}
          type="button"
          onClick={() => handleOpen(p.profileId)}
          disabled={openingId !== null}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-border bg-background hover:bg-muted/60 transition-colors disabled:opacity-50"
          title={t(
            "proxy.failoverProfiles.switcherItemTitle",
            "为该档案开一个专属端口终端",
          )}
        >
          {openingId === p.profileId ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <FolderOpen className="h-3 w-3" />
          )}
          <span className="max-w-[160px] truncate">{p.name}</span>
          {p.port != null && (
            <span className="font-mono text-[10px] text-blue-600 dark:text-blue-400">
              :{p.port}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
