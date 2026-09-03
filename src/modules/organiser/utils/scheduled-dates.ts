export function isIsoDateString(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validDate(value: Date): boolean {
  return !Number.isNaN(value.getTime());
}

export function formatIsoDate(value: Date): string {
  return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, "0"), String(value.getDate()).padStart(2, "0")].join("-");
}

export function dateFromIso(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return new Date(Number.NaN);
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return formatIsoDate(date) === value ? date : new Date(Number.NaN);
}

export function startOfIsoWeek(value = new Date()): Date {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return date;
}

export function addCalendarDays(value: Date, days: number): Date {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

export function calendarWeekOffset(value: Date, reference = new Date()): number {
  const selected = startOfIsoWeek(value);
  const current = startOfIsoWeek(reference);
  const utc = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((utc(selected) - utc(current)) / (7 * 24 * 60 * 60 * 1000));
}

function ordinal(day: number): string {
  const mod100 = day % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  return `${day}${suffix}`;
}

export function formatPlannerDay(value: Date): string {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(value);
  const month = new Intl.DateTimeFormat("en-US", { month: "short" }).format(value);
  return `${weekday} ${ordinal(value.getDate())} ${month}`;
}

export function formatPlannerDate(value: Date, includeWeekday: boolean, includeYear: boolean): string {
  const weekday = includeWeekday ? `${new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(value)} ` : "";
  const month = new Intl.DateTimeFormat("en-US", { month: "short" }).format(value);
  return `${weekday}${month} ${ordinal(value.getDate())}${includeYear ? `, ${value.getFullYear()}` : ""}`;
}

export function normalizeFrontmatterDate(
  value: unknown,
  { format = "YYYY-MM-DD", onInvalid = null }: { format?: string; onInvalid?: string | null } = {}
): string | null {
  if (typeof value !== "string") return onInvalid;
  const trimmed = value.trim();
  if (!trimmed) return onInvalid;
  let parsed: Date;
  if (isIsoDateString(trimmed)) parsed = dateFromIso(trimmed);
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    parsed = new Date(trimmed);
  } else {
    const rfc = /^[A-Za-z]{3}, (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(trimmed);
    const month = rfc ? ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(rfc[2]) : -1;
    if (!rfc || month < 0) return onInvalid;
    const offset = (Number(rfc[8]) * 60 + Number(rfc[9])) * (rfc[7] === "+" ? 1 : -1);
    parsed = new Date(Date.UTC(Number(rfc[3]), month, Number(rfc[1]), Number(rfc[4]), Number(rfc[5]), Number(rfc[6])) - offset * 60_000);
  }
  if (!validDate(parsed)) return onInvalid;
  if (format === "YYYY-MM-DD") return formatIsoDate(parsed);
  return onInvalid;
}
