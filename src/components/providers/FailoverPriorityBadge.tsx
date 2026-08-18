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
 * 命名档案配色板的「卡片边框」变体：border + shadow。
 *
 * 用于把整个供应商卡片染成其所属命名档案的颜色——当供应商在某个命名档案中时，
 * 卡片边框取该档案配色，与档案徽章同色，视觉上一眼可见该 provider 归属哪个档案。
 * 优先级低于 activeProvider 的绿色边框（active 时仍显示绿色）。
 */
const PROFILE_BORDER_COLORS = [
  "border-sky-500/60 shadow-sm shadow-sky-500/10",
  "border-violet-500/60 shadow-sm shadow-violet-500/10",
  "border-amber-500/60 shadow-sm shadow-amber-500/10",
  "border-rose-500/60 shadow-sm shadow-rose-500/10",
  "border-cyan-500/60 shadow-sm shadow-cyan-500/10",
  "border-fuchsia-500/60 shadow-sm shadow-fuchsia-500/10",
] as const;

/** 取档案边框配色（与 `getFailoverProfileColorClass` 同索引，保证徽章与卡片同色）。 */
export function getFailoverProfileBorderColorClass(colorIndex: number): string {
  const len = PROFILE_BORDER_COLORS.length;
  const safe = ((Math.trunc(colorIndex) % len) + len) % len;
  return PROFILE_BORDER_COLORS[safe];
}

/**
 * 命名档案配色板的「卡片底色」变体：半透明渐变。
 *
 * 用于把整个供应商卡片染成其所属命名档案的颜色——与档案徽章同色，
 * 视觉上一眼可见该 provider 归属哪个档案。当 provider 在某个命名档案中时，
 * 卡片底色取该档案配色，优先级高于 active 的 emerald/blue 渐变。
 */
const PROFILE_BG_COLORS = [
  "from-sky-500/10",
  "from-violet-500/10",
  "from-amber-500/10",
  "from-rose-500/10",
  "from-cyan-500/10",
  "from-fuchsia-500/10",
] as const;

/** 取档案底色（与 `getFailoverProfileColorClass` 同索引，保证徽章、边框、底色三者同色）。 */
export function getFailoverProfileBgColorClass(colorIndex: number): string {
  const len = PROFILE_BG_COLORS.length;
  const safe = ((Math.trunc(colorIndex) % len) + len) % len;
  return PROFILE_BG_COLORS[safe];
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
