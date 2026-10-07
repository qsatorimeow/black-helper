// Роли и права доступа. Хранилище — Upstash Redis (Sets).
// Три уровня охвата: глобальный (весь проект), серверный (все беседы сервера),
// по беседе (только эта беседа).
import { redis } from "./kv.ts";

export type GlobalRole = "spec_admin" | "deputy_spec_admin";
export type ServerRole = "main_admin" | "king_salad";
export type ChatRole = "deputy_main_admin" | "senior_admin" | "admin" | "senior_moderator" | "moderator";
export type AnyRole = "developer" | GlobalRole | ServerRole | ChatRole | "user";

export const ROLE_WEIGHT: Record<AnyRole, number> = {
  developer: 100,
  spec_admin: 95,
  deputy_spec_admin: 90,
  main_admin: 85,
  king_salad: 87,
  deputy_main_admin: 80,
  senior_admin: 70,
  admin: 60,
  senior_moderator: 50,
  moderator: 40,
  user: 0,
};

export const ROLE_LABEL: Record<AnyRole, string> = {
  developer: "Разработчик",
  spec_admin: "Спец. администратор",
  deputy_spec_admin: "Зам. спец. администратора",
  main_admin: "Главный администратор",
  king_salad: "Король салатников",
  deputy_main_admin: "Зам. главного администратора",
  senior_admin: "Старший администратор",
  admin: "Администратор",
  senior_moderator: "Старший модератор",
  moderator: "Модератор",
  user: "Пользователь",
};

/** Форма "права ___" — родительный падеж, для сообщений о назначении/снятии ранга. */
export const ROLE_GENITIVE: Record<AnyRole, string> = {
  developer: "разработчика",
  spec_admin: "спец. администратора",
  deputy_spec_admin: "зам. спец. администратора",
  main_admin: "главного администратора",
  king_salad: "короля салатников",
  deputy_main_admin: "зам. главного администратора",
  senior_admin: "старшего администратора",
  admin: "администратора",
  senior_moderator: "старшего модератора",
  moderator: "модератора",
  user: "пользователя",
};

const CHAT_ROLES: ChatRole[] = ["deputy_main_admin", "senior_admin", "admin", "senior_moderator", "moderator"];
const SERVER_ROLES: ServerRole[] = ["king_salad", "main_admin"];

function developerIds(): number[] {
  return (Deno.env.get("DEVELOPER_IDS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
}

export function isDeveloperId(userId: number): boolean {
  return developerIds().includes(userId);
}

// --- Глобальные роли ---

function globalRoleKey(role: GlobalRole): string {
  return `b2:role:global:${role}`;
}

export async function addGlobalRole(role: GlobalRole, userId: number): Promise<void> {
  await redis.sadd(globalRoleKey(role), String(userId));
}

export async function removeGlobalRole(role: GlobalRole, userId: number): Promise<void> {
  await redis.srem(globalRoleKey(role), String(userId));
}

export async function getGlobalRoleMembers(role: GlobalRole): Promise<number[]> {
  const members = await redis.smembers(globalRoleKey(role));
  return (members ?? []).map(Number);
}

export async function getUserGlobalRole(userId: number): Promise<GlobalRole | null> {
  const [isSpec, isDeputy] = await Promise.all([
    redis.sismember(globalRoleKey("spec_admin"), String(userId)),
    redis.sismember(globalRoleKey("deputy_spec_admin"), String(userId)),
  ]);
  if (isSpec) return "spec_admin";
  if (isDeputy) return "deputy_spec_admin";
  return null;
}

// --- Серверные роли (Главный администратор / Зам. главного администратора) ---

function serverRoleKey(serverNameLower: string, role: ServerRole): string {
  return `b2:role:server:${serverNameLower}:${role}`;
}

export async function addServerRole(serverName: string, role: ServerRole, userId: number): Promise<void> {
  await redis.sadd(serverRoleKey(serverName.toLowerCase(), role), String(userId));
}

export async function removeServerRole(serverName: string, role: ServerRole, userId: number): Promise<void> {
  await redis.srem(serverRoleKey(serverName.toLowerCase(), role), String(userId));
}

export async function getServerRoleMembers(serverName: string, role: ServerRole): Promise<number[]> {
  const members = await redis.smembers(serverRoleKey(serverName.toLowerCase(), role));
  return (members ?? []).map(Number);
}

export async function getUserServerRole(serverName: string, userId: number): Promise<ServerRole | null> {
  for (const role of SERVER_ROLES) {
    if (await redis.sismember(serverRoleKey(serverName.toLowerCase(), role), String(userId))) return role;
  }
  return null;
}

export { SERVER_ROLES };

// --- Роли в рамках конкретной беседы ---

function chatRoleKey(peerId: number, role: ChatRole): string {
  return `b2:role:chat:${peerId}:${role}`;
}

export async function addChatRole(peerId: number, role: ChatRole, userId: number): Promise<void> {
  await redis.sadd(chatRoleKey(peerId, role), String(userId));
}

export async function removeChatRole(peerId: number, role: ChatRole, userId: number): Promise<void> {
  await redis.srem(chatRoleKey(peerId, role), String(userId));
}

export async function getChatRoleMembers(peerId: number, role: ChatRole): Promise<number[]> {
  const members = await redis.smembers(chatRoleKey(peerId, role));
  return (members ?? []).map(Number);
}

export async function getUserChatRole(peerId: number, userId: number): Promise<ChatRole | null> {
  for (const role of CHAT_ROLES) {
    if (await redis.sismember(chatRoleKey(peerId, role), String(userId))) return role;
  }
  return null;
}

export { CHAT_ROLES };

/** Итоговая роль пользователя в конкретной беседе (с учётом сервера, к которому она привязана). */
export async function resolveUserRole(
  peerId: number,
  userId: number,
  chatServerName: string | null,
): Promise<{ role: AnyRole; weight: number }> {
  if (isDeveloperId(userId)) return { role: "developer", weight: ROLE_WEIGHT.developer };

  const globalRole = await getUserGlobalRole(userId);
  if (globalRole) return { role: globalRole, weight: ROLE_WEIGHT[globalRole] };

  if (chatServerName) {
    const serverRole = await getUserServerRole(chatServerName, userId);
    if (serverRole) return { role: serverRole, weight: ROLE_WEIGHT[serverRole] };
  }

  const chatRole = await getUserChatRole(peerId, userId);
  if (chatRole) return { role: chatRole, weight: ROLE_WEIGHT[chatRole] };

  return { role: "user", weight: ROLE_WEIGHT.user };
}

export async function hasAtLeastRole(
  peerId: number,
  userId: number,
  chatServerName: string | null,
  minRole: AnyRole,
): Promise<boolean> {
  const { weight } = await resolveUserRole(peerId, userId, chatServerName);
  return weight >= ROLE_WEIGHT[minRole];
}
