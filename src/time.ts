function getLocalHour(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hour12: false,
    timeZone: timezone
  });

  const parts = formatter.formatToParts(date);
  const hourPart = parts.find((part) => part.type === "hour")?.value ?? "0";
  const parsed = Number(hourPart);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isWithinCallingWindow(
  date: Date,
  timezone: string,
  startHour: number,
  endHour: number
): boolean {
  const hour = getLocalHour(date, timezone);

  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }

  // Overnight window support (e.g. 22 -> 6)
  return hour >= startHour || hour < endHour;
}
