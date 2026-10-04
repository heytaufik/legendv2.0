import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SESSION_RETENTION_SESSIONS = 7;

export function indiaDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function calculateValueArea(profile) {
  const levels = [...profile].map(([price, volume]) => [Number(price), Number(volume)])
    .filter(([price, volume]) => Number.isFinite(price) && Number.isFinite(volume) && volume > 0)
    .sort(([left], [right]) => left - right);
  const totalVolume = levels.reduce((total, [, volume]) => total + volume, 0);
  if (!levels.length || totalVolume === 0) return { vah: null, poc: null, val: null, totalVolume: 0 };

  const pocIndex = levels.reduce((best, level, index) => level[1] > levels[best][1] ? index : best, 0);
  let lowIndex = pocIndex;
  let highIndex = pocIndex;
  let areaVolume = levels[pocIndex][1];
  while (areaVolume < totalVolume * 0.7 && (lowIndex > 0 || highIndex < levels.length - 1)) {
    const lowerVolume = lowIndex > 0 ? levels[lowIndex - 1][1] : -1;
    const upperVolume = highIndex < levels.length - 1 ? levels[highIndex + 1][1] : -1;
    if (upperVolume > lowerVolume) areaVolume += levels[++highIndex][1];
    else areaVolume += levels[--lowIndex][1];
  }
  return { vah: levels[highIndex][0], poc: levels[pocIndex][0], val: levels[lowIndex][0], totalVolume };
}

export function buildProfileBins(profile, tickSize = 0.05, maximumBucketTicks = 60) {
  const levels = [...profile].map(([price, volume]) => [Number(price), Number(volume)])
    .filter(([price, volume]) => Number.isFinite(price) && Number.isFinite(volume) && volume >= 0);
  if (!levels.length) return [];

  const minimumPrice = Math.min(...levels.map(([price]) => price));
  const maximumPrice = Math.max(...levels.map(([price]) => price));
  const safeTickSize = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.05;
  const bucketTicks = Math.max(1, Math.ceil((maximumPrice - minimumPrice) / (safeTickSize * maximumBucketTicks)));
  const bucketSize = bucketTicks * safeTickSize;
  const minimumBucket = Math.floor(minimumPrice / bucketSize);
  const maximumBucket = Math.floor(maximumPrice / bucketSize);
  const volumes = new Map();
  for (const [price, volume] of levels) {
    const bucket = Math.floor(price / bucketSize);
    volumes.set(bucket, (volumes.get(bucket) || 0) + volume);
  }

  return Array.from({ length: maximumBucket - minimumBucket + 1 }, (_, index) => {
    const bucket = minimumBucket + index;
    const price = Number((bucket * bucketSize).toFixed(8));
    return { price, high: Number((price + bucketSize).toFixed(8)), volume: volumes.get(bucket) || 0 };
  });
}

export function detectLowVolumeZones(levels, valueArea, thresholdRatio = 0.75) {
  const candidates = [];
  for (let index = 1; index < levels.length - 1; index += 1) {
    const volume = levels[index].volume;
    let leftIndex = index - 1;
    let rightIndex = index + 1;
    while (leftIndex >= 0 && levels[leftIndex].volume <= 0) leftIndex -= 1;
    while (rightIndex < levels.length && levels[rightIndex].volume <= 0) rightIndex += 1;
    if (leftIndex < 0 || rightIndex >= levels.length) continue;
    const neighborThreshold = Math.min(levels[leftIndex].volume, levels[rightIndex].volume) * thresholdRatio;
    if (volume > 0 && volume < neighborThreshold) candidates.push(index);
  }

  const groups = [];
  for (const index of candidates) {
    const lastGroup = groups.at(-1);
    if (lastGroup && index === lastGroup.endIndex + 1) lastGroup.endIndex = index;
    else groups.push({ startIndex: index, endIndex: index });
  }

  return groups.map(({ startIndex, endIndex }) => {
    const low = levels[startIndex].price;
    const high = levels[endIndex].high ?? levels[endIndex].price;
    const volume = levels.slice(startIndex, endIndex + 1).reduce((total, level) => total + level.volume, 0);
    const inside = Number.isFinite(valueArea?.vah) && Number.isFinite(valueArea?.val);
    const valueAreaStatus = !inside
      ? 'UNAVAILABLE'
      : low >= valueArea.val && high <= valueArea.vah
        ? 'INSIDE'
        : high <= valueArea.val || low >= valueArea.vah
          ? 'OUTSIDE'
          : 'OVERLAPS';
    return {
      low,
      high,
      center: Number(((low + high) / 2).toFixed(8)),
      volume,
      valueAreaStatus,
      startIndex,
      endIndex
    };
  });
}

export function untestedHistoricalLowVolumeZones(sessions, instrument, currentDate, currentProfile, tickSize = 0.05, lookbackSessions = 7) {
  const dates = Object.keys(sessions)
    .filter((date) => date <= currentDate)
    .sort()
    .slice(-lookbackSessions);
  const laterSessions = dates.map((date) => ({
    date,
    profile: date === currentDate ? currentProfile : Object.entries(sessions[date]?.[instrument]?.profile || {})
  }));
  const historicalZones = [];

  for (const date of dates.filter((sessionDate) => sessionDate < currentDate)) {
    const session = sessions[date]?.[instrument];
    const entries = Object.entries(session?.profile || {});
    if (entries.length < 3) continue;
    const area = { vah: session.vah, val: session.val };
    const zones = detectLowVolumeZones(buildProfileBins(entries, tickSize), area);
    for (const zone of zones) {
      const tested = laterSessions
        .filter((later) => later.date > date)
        .some((later) => later.profile.some(([price]) => Number(price) >= zone.low && Number(price) <= zone.high));
      if (!tested) historicalZones.push({
        ...zone,
        date,
        source: session.profileSource === 'FYERS_CHART' ? 'FYERS_CHART' : 'TICK_RULE_ESTIMATE'
      });
    }
  }

  return historicalZones.sort((left, right) => right.date.localeCompare(left.date) || left.low - right.low);
}

export function classifyOpening(open, previousArea) {
  if (!Number.isFinite(open)) return 'WAITING_OPEN';
  if (!Number.isFinite(previousArea?.vah) || !Number.isFinite(previousArea?.val)) return 'WAITING_PRIOR_VALUE';
  if (open > previousArea.vah) return 'UP';
  if (open < previousArea.val) return 'DOWN';
  return 'INSIDE';
}

export function latestSessionBefore(sessions, instrument, beforeDate = indiaDateKey()) {
  const date = Object.keys(sessions)
    .filter((sessionDate) => sessionDate < beforeDate && Number.isFinite(sessions[sessionDate]?.[instrument]?.vah) && Number.isFinite(sessions[sessionDate]?.[instrument]?.val))
    .sort()
    .at(-1);
  return date ? { date, ...sessions[date][instrument] } : null;
}

export function pruneSessions(sessions, asOfDate = indiaDateKey(), retentionSessions = SESSION_RETENTION_SESSIONS) {
  return Object.fromEntries(Object.entries(sessions)
    .filter(([date]) => date <= asOfDate)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-retentionSessions));
}

export async function readSessionArchive(filePath, asOfDate = indiaDateKey()) {
  try {
    const sessions = JSON.parse(await readFile(filePath, 'utf8'));
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return {};
    return pruneSessions(sessions, asOfDate);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function writeSessionArchive(filePath, sessions) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(sessions), { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, filePath);
}
