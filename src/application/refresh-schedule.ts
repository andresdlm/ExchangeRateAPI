import type { RefreshPolicy } from './get-rates';

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;
const CARACAS_UTC_OFFSET_MILLISECONDS = 4 * MILLISECONDS_PER_HOUR;
const SUNDAY = 0;
const SATURDAY = 6;

function isWeekend(timestamp: number): boolean {
  const localDate = new Date(timestamp - CARACAS_UTC_OFFSET_MILLISECONDS);
  const dayOfWeek = localDate.getUTCDay();
  return dayOfWeek === SUNDAY || dayOfWeek === SATURDAY;
}

/** Most recent Monday-Friday publication window, in Venezuela (UTC-4). */
export function publicationBoundary(currentTime: number, publicationHour: number): number {
  // Shift the date to Venezuela time, then use UTC getters to avoid host timezone changes.
  const localDate = new Date(currentTime - CARACAS_UTC_OFFSET_MILLISECONDS);
  const localPublicationTime = Date.UTC(
    localDate.getUTCFullYear(),
    localDate.getUTCMonth(),
    localDate.getUTCDate(),
    publicationHour,
  );

  let boundary = localPublicationTime + CARACAS_UTC_OFFSET_MILLISECONDS;

  if (boundary > currentTime) {
    boundary -= MILLISECONDS_PER_DAY;
  }

  while (isWeekend(boundary)) {
    boundary -= MILLISECONDS_PER_DAY;
  }

  return boundary;
}

export function dailyRefresh(publicationHour: number): RefreshPolicy {
  return (checkedAt, currentTime) => {
    const lastVerificationTime = Date.parse(checkedAt);
    const latestPublicationTime = publicationBoundary(currentTime, publicationHour);
    return lastVerificationTime < latestPublicationTime;
  };
}
