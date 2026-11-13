import { fill, learningCopy } from "../copy/learning";

/** How long until a card comes back, e.g. "10 分鐘", "3 天". */
export function intervalLabel(ms: number, intervals = learningCopy().review.intervals): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return minutes === 1 ? intervals.oneMinute : fill(intervals.minutes, { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? intervals.oneHour : fill(intervals.hours, { n: hours });
  const days = Math.round(hours / 24);
  if (days < 31) return days === 1 ? intervals.oneDay : fill(intervals.days, { n: days });
  const months = Math.round(days / 30);
  if (months < 12) return months === 1 ? intervals.oneMonth : fill(intervals.months, { n: months });
  const years = (days / 365).toFixed(1);
  return years === "1.0" ? intervals.oneYear : fill(intervals.years, { n: years });
}
