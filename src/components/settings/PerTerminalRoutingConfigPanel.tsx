import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  settingsApi,
  type PerTerminalRoutingConfig,
} from "@/lib/api/settings";

/**
 * 按终端路由配置面板（Feature #2）。
 *
 * 开启后，不同 Codex / Claude Code 终端（按 session_id 区分）可绑定不同的
 * 故障转移档案或起点，使多个终端各自走独立的故障转移链路。
 *
 * 「下一个新终端使用哪个档案」的预设选择在「命名故障转移档案」面板内（每个
 * 应用 Tab 下），此处只保留全局总开关。
 *
 * 后端开关默认关闭，关闭时 `select_providers_for_session` 退化为 `select_providers`，
 * 零回归。
 */
export function PerTerminalRoutingConfigPanel() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<PerTerminalRoutingConfig>({
    enabled: false,
    nextNewTerminalProfileId: null,
  });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    settingsApi
      .getPerTerminalRoutingConfig()
      .then(setConfig)
      .catch((e) => console.error("Failed to load per-terminal routing config:", e))
      .finally(() => setIsLoading(false));
  }, []);

  const handleChange = async (updates: Partial<PerTerminalRoutingConfig>) => {
    const newConfig = { ...config, ...updates };
    setConfig(newConfig);
    try {
      await settingsApi.setPerTerminalRoutingConfig(newConfig);
    } catch (e) {
      console.error("Failed to save per-terminal routing config:", e);
      toast.error(String(e));
      setConfig(config);
    }
  };

  if (isLoading) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label>{t("settings.advanced.perTerminalRouting.enabled")}</Label>
          <p className="text-xs text-muted-foreground">
            {t("settings.advanced.perTerminalRouting.enabledDescription")}
          </p>
        </div>
        <Switch
          checked={config.enabled}
          onCheckedChange={(checked) => handleChange({ enabled: checked })}
        />
      </div>

      <div className="rounded-lg bg-muted/40 border border-border/40 p-4">
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t("settings.advanced.perTerminalRouting.note")}
        </p>
      </div>
    </div>
  );
}
