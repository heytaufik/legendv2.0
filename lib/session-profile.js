import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SESSION_RETENTION_SESSIONS = 14;

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
