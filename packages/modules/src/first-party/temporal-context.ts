/** 将冻结时刻稳定格式化为 Agent 所在时区的中文时间。 */
export interface ZonedInstant {
  readonly iso: string;
  readonly timeZone: string;
  readonly local: string;
}

export function formatZonedInstant(
  iso: string,
  timeZone: string,
): ZonedInstant {
  const instant = new Date(iso);
  if (!Number.isFinite(instant.getTime())) throw new Error("Invalid instant");
  const parts = new Intl.DateTimeFormat("zh-CN-u-ca-gregory-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return {
    iso: instant.toISOString(),
    timeZone,
    local: `${part("year")}-${part("month")}-${part("day")} ${part("weekday")} ${part("hour")}:${part("minute")}:${part("second")}`,
  };
}
