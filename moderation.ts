// Баны (чат/сервер/глобально), кики, мут, тайм-аут, антифлуд.
import { redis } from "./kv.ts";
import { kickFromChat } from "./vk.ts";
import { getChatServer, getServerChats } from "./servers.ts";

export type BanEventType = "ban" | "unban" | "sban" | "sunban" | "gban" | "gunban" | "kick" | "skick" | "gkick";

export interface BanRecord {
  reason: string;
  byUserId: number;
  byWeight: number; // ранг выдавшего НА МОМЕНТ выдачи — снять может только тот, у кого выше
  at: number;
  label?: string; // название чата/сервера, где выдан бан — для отображения
}

export interface BanHistoryEntry extends BanRecord {
  type: BanEventType;
  peerId?: number;
}

function historyKey(userId: number): string {
  return `b2:banhistory:${userId}`;
}

export async function logBanEvent(userId: number, entry: BanHistoryEntry): Promise<void> {
  await redis.rpush(historyKey(userId), JSON.stringify(entry));
}

export async function getBanHistory(userId: number): Promise<BanHistoryEntry[]> {
  const raw = await redis.lrange<string>(historyKey(userId), 0, -1);
  const list = (raw ?? []).map((r) => (typeof r === "string" ? JSON.parse(r) : r) as BanHistoryEntry);
  return list.reverse(); // самые новые сверху
}

// --- Бан в одной беседе (/ban, /unban) ---

function chatBanKey(peerId: number, userId: number): string {
  return `b2:ban:${peerId}:${userId}`;
}

export async function setChatBan(peerId: number, userId: number, record: BanRecord): Promise<void> {
  await redis.set(chatBanKey(peerId, userId), record);
}

export async function clearChatBan(peerId: number, userId: number): Promise<void> {
  await redis.del(chatBanKey(peerId, userId));
}

export async function getChatBan(peerId: number, userId: number): Promise<BanRecord | null> {
  return (await redis.get<BanRecord>(chatBanKey(peerId, userId))) ?? null;
}

// --- Бан во всех беседах СЕРВЕРА (/sban, /sunban) ---

function serverBanKey(serverNameLower: string, userId: number): string {
  return `b2:sban:${serverNameLower}:${userId}`;
}

export async function setServerBan(serverName: string, userId: number, record: BanRecord): Promise<void> {
  const nameLower = serverName.toLowerCase();
  await redis.set(serverBanKey(nameLower, userId), record);
  await redis.sadd(`b2:sban_servers:${userId}`, nameLower);
}

export async function clearServerBan(serverName: string, userId: number): Promise<void> {
  const nameLower = serverName.toLowerCase();
  await redis.del(serverBanKey(nameLower, userId));
  await redis.srem(`b2:sban_servers:${userId}`, nameLower);
}

export async function getServerBan(serverName: string, userId: number): Promise<BanRecord | null> {
  return (await redis.get<BanRecord>(serverBanKey(serverName.toLowerCase(), userId))) ?? null;
}

export async function getAllServerBans(userId: number): Promise<{ serverName: string; record: BanRecord }[]> {
  const serverNames = await redis.smembers(`b2:sban_servers:${userId}`);
  const result: { serverName: string; record: BanRecord }[] = [];
  for (const nameLower of serverNames ?? []) {
    const record = await getServerBan(nameLower, userId);
    if (record) result.push({ serverName: nameLower, record });
  }
  return result;
}

// --- Глобальный бан (/gban, /gunban) — во всех беседах проекта ---

function globalBanKey(userId: number): string {
  return `b2:gban:${userId}`;
}

export async function setGlobalBan(userId: number, record: BanRecord): Promise<void> {
  await redis.set(globalBanKey(userId), record);
}

export async function clearGlobalBan(userId: number): Promise<void> {
  await redis.del(globalBanKey(userId));
}

export async function getGlobalBan(userId: number): Promise<BanRecord | null> {
  return (await redis.get<BanRecord>(globalBanKey(userId))) ?? null;
}

/** Есть ли у пользователя любая активная блокировка, действующая именно в этом чате. */
export async function getActiveBanForChat(peerId: number, userId: number): Promise<BanRecord | null> {
  const globalBan = await getGlobalBan(userId);
  if (globalBan) return globalBan;

  const chatBan = await getChatBan(peerId, userId);
  if (chatBan) return chatBan;

  const serverName = await getChatServer(peerId);
  if (serverName) {
    const serverBan = await getServerBan(serverName, userId);
    if (serverBan) return serverBan;
  }
  return null;
}

// --- Массовые кики ---

export async function kickFromServerChats(serverName: string, userId: number): Promise<number> {
  const chats = await getServerChats(serverName);
  for (const peerId of chats) await kickFromChat(peerId, userId).catch(() => {});
  return chats.length;
}

export async function kickFromAllSyncedChats(userId: number): Promise<number> {
  const peerIds = await redis.smembers("b2:synced_chats");
  for (const peerIdStr of peerIds ?? []) await kickFromChat(Number(peerIdStr), userId).catch(() => {});
  return (peerIds ?? []).length;
}

// --- Мут (в рамках одной беседы), с данными для кнопок "снять"/"очистить" ---

export interface MuteRecord {
  reason: string;
  byUserId: number;
  expiresAt: number;
  botCmid?: number; // сообщение бота о муте — для кнопок и последующей очистки
  moderatorCmid?: number; // сообщение с командой /mute — удаляется при "очистить"
  targetCmid?: number; // сообщение нарушителя, на которое ответили — удаляется при "очистить"
}

function muteKey(peerId: number, userId: number): string {
  return `b2:mute:${peerId}:${userId}`;
}

export async function setMute(peerId: number, userId: number, record: MuteRecord): Promise<void> {
  const ttlSec = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000));
  await redis.set(muteKey(peerId, userId), record, { ex: ttlSec });
}

export async function clearMute(peerId: number, userId: number): Promise<void> {
  await redis.del(muteKey(peerId, userId));
}

export async function getMute(peerId: number, userId: number): Promise<MuteRecord | null> {
  return (await redis.get<MuteRecord>(muteKey(peerId, userId))) ?? null;
}

export async function isMuted(peerId: number, userId: number): Promise<boolean> {
  return (await redis.exists(muteKey(peerId, userId))) === 1;
}

// --- Режим тишины на весь чат (/timeout) ---

function timeoutKey(peerId: number): string {
  return `b2:timeout:${peerId}`;
}

export async function setTimeoutMode(peerId: number, on: boolean): Promise<void> {
  if (on) await redis.set(timeoutKey(peerId), "1");
  else await redis.del(timeoutKey(peerId));
}

export async function isTimeoutActive(peerId: number): Promise<boolean> {
  return (await redis.exists(timeoutKey(peerId))) === 1;
}

// --- Антифлуд: более 5 одинаковых сообщений подряд — кик ---

interface FloodState {
  lastText: string;
  count: number;
}

function floodKey(peerId: number, userId: number): string {
  return `b2:flood:${peerId}:${userId}`;
}

export async function trackFloodAndShouldKick(peerId: number, userId: number, text: string): Promise<boolean> {
  if (!text) return false;
  const raw = await redis.get<FloodState | string>(floodKey(peerId, userId));
  const state: FloodState = raw
    ? (typeof raw === "string" ? JSON.parse(raw) : raw)
    : { lastText: "", count: 0 };

  if (text === state.lastText) state.count++;
  else {
    state.lastText = text;
    state.count = 1;
  }

  if (state.count > 5) {
    await redis.del(floodKey(peerId, userId));
    return true;
  }
  await redis.set(floodKey(peerId, userId), state, { ex: 300 });
  return false;
}

