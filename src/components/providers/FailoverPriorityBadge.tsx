import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface FailoverPriorityBadgeProps {
  priority: number; // 1, 2, 3, ...
  /** 命名档案配色索引；缺省 = 默认共享队列（emerald，与旧版完全一致）。 */
  colorIndex?: number;
  /** 命名档案名称；提供时进入 tooltip（形如「档案名 · P2」）。 */
  profileName?: string;
  className?: string;
}

/** 默认共享队列配色（保持与旧版逐字一致，零视觉回归）。 */
const DEFAULT_PRIORITY_COLOR =
  "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";

/**
 * 命名档案配色板。
 *
 * 刻意不含 emerald：emerald 保留给默认共享队列，避免同一张卡片上
 * 「共享队列徽章」与「命名档案徽章」撞色导致误读。
 */
const PROFILE_PRIORITY_COLORS = [
  "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
] as const;

/** 取档案配色：按索引对配色板取模，同一档案永远同色。 */
export function getFailoverProfileColorClass(colorIndex: number): string {
  const len = PROFILE_PRIORITY_COLORS.length;
  const safe = ((Math.trunc(colorIndex) % len) + len) % len;
  return PROFILE_PRIORITY_COLORS[safe];
}

/**
 * 故障转移优先级徽章
 * 显示供应商在故障转移队列（或某个命名档案）中的优先级顺序
 */
export function FailoverPriorityBadge({
  priority,
  colorIndex,
  profileName,
  className,
}: FailoverPriorityBadgeProps) {
  const { t } = useTranslation();

  const colorClass =
    colorIndex === undefined
      ? DEFAULT_PRIORITY_COLOR
      : getFailoverProfileColorClass(colorIndex);

  const tooltip = profileName
    ? t("failover.priority.profileTooltip", {
        profileName,
        priority,
        defaultValue: `${profileName} · P${priority}`,
      })
    : t("failover.priority.tooltip", {
        priority,
        defaultValue: `故障转移优先级 ${priority}`,
      });

  return (
    <div
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold",
        colorClass,
        className,
      )}
      title={tooltip}
    >
      P{priority}
    </div>
  );
}
