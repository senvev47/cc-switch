import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  settingsApi,
  type PerTerminalRoutingConfig,
} from "@/lib/api/settings";

/**
 * 按终端路由配置面板（Feature #2）。
 *
 * 开启后，不同 Codex 终端（按 session_id 区分）可绑定不同的故障转移链起点：
 * - reuse：新终端沿用全局起点（P1），与历史行为一致。
 * - rotate：新终端轮转起点，使多终端尽量分散到不同上游。
 *
 * 后端开关默认关闭，关闭时 `select_providers_for_session` 退化为 `select_providers`，零回归。
 */
export function PerTerminalRoutingConfigPanel() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<PerTerminalRoutingConfig>({
    enabled: false,
    newTerminalPolicy: "reuse",
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

      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label>{t("settings.advanced.perTerminalRouting.newTerminalPolicy")}</Label>
          <p className="text-xs text-muted-foreground">
            {t("settings.advanced.perTerminalRouting.newTerminalPolicyDescription")}
          </p>
        </div>
        <Select
          value={config.newTerminalPolicy}
          disabled={!config.enabled}
          onValueChange={(value) => handleChange({ newTerminalPolicy: value })}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="reuse">
              {t("settings.advanced.perTerminalRouting.policyReuse")}
            </SelectItem>
            <SelectItem value="rotate">
              {t("settings.advanced.perTerminalRouting.policyRotate")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg bg-muted/40 border border-border/40 p-4">
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t("settings.advanced.perTerminalRouting.note")}
        </p>
      </div>
    </div>
  );
}
