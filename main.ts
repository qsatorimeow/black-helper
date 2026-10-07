// Бот 2 (astana-manager) — Deno Deploy + Upstash Redis
// ------------------------------------------------------
// Три уровня ролей: глобальный (весь проект), серверный (только Главный
// администратор — один на сервер), по беседе (всё остальное, но действие
// команд вроде /sban всё равно распространяется на все чаты сервера).
//
// Настройка беседы: /sync (получает/обновляет название и владельца чата)
// → /server название (привязка к серверу). Обе команды можно вызывать
// повторно. До /sync бот молчит на все прочие команды.
//
// Символы вызова команды: / + !
// Цель команды: реплай — в приоритете; если реплая нет — явное упоминание/
// ник/ссылка/id первым аргументом.
// Назначение ранга можно коротко (/moder, /admin, /senadmin, /zga, /zsa, /sa),
// снятие — только полной формой (/delmoder и т.д.)

import { redis, scanKeys } from "./kv.ts";
import {
  callVkApi,
  getBotGroupId,
  getConversationMembers,
  getOnlineMembers,
  getUsersInfo,
  isChatPeer,
  kickFromChat,
  nameLinkOf,
  resolveTargetUserId,
  sendMessageAndGetIds,
} from "./vk.ts";
import {
  addChatRole,
  addGlobalRole,
  addServerRole,
  type AnyRole,
  CHAT_ROLES,
  type ChatRole,
  getServerRoleMembers,
  getUserChatRole,
  getUserGlobalRole,
  type GlobalRole,
  hasAtLeastRole,
  isDeveloperId,
  removeChatRole,
  removeGlobalRole,
  removeServerRole,
  resolveUserRole,
  ROLE_GENITIVE,
  ROLE_LABEL,
  type ServerRole,
} from "./roles.ts";
import {
  buildSyncListMessage,
  clearSync,
  getConfigStatusMessage,
  getSyncRecord,
  isChatConfigured,
  isSynced,
  syncChat,
} from "./setup.ts";
import {
  addServer,
  bindChatToServer,
  getChatServer,
  getServerChats,
  listServers,
  removeServer,
  serverExists,
} from "./servers.ts";
import { clearActivity, getMessageStats, trackMessage } from "./activity.ts";
import {
  type BanRecord,
  clearChatBan,
  clearGlobalBan,
  clearMute,
  clearServerBan,
  getActiveBanForChat,
  getAllServerBans,
  getBanHistory,
  getChatBan,
  getGlobalBan,
  getMute,
  getServerBan,
  isMuted,
  isTimeoutActive,
  kickFromAllSyncedChats,
  kickFromServerChats,
  logBanEvent,
  type MuteRecord,
  setChatBan,
  setGlobalBan,
  setMute,
  setServerBan,
  setTimeoutMode,
  trackFloodAndShouldKick,
} from "./moderation.ts";
import { findUserIdByNick, getNickFor, listNicks, removeNickFor, setNickFor } from "./nicknames.ts";
import { ALT_MAP, ALT_TEXT, buildHelpMessage, buildStaffMessage } from "./staff.ts";

const VK_CONFIRMATION = Deno.env.get("VK_CONFIRMATION") ?? "";
const VK_SECRET = Deno.env.get("VK_SECRET") ?? "";
const NO_PERMISSION = "Недостаточно прав!";
const NO_TARGET = "Вы не указали пользователя";
const NO_REASON = "Вы не указали причину";
const NO_MUTE_TIME = "Вы не указали время мута";

const INFO_TEXT = [
  "Официальные ресурсы проекта:",
  "Разработчик — https://vk.com/id1104716287",
  "Тех поддержка — https://vk.com/id1104716287",
  "Начать сотрудничество — https://vk.ru/id1104716287",
  "Спец администратор — https://vk.ru/id1104716287",
].join("\n");

async function alreadyProcessed(eventId: string | undefined): Promise<boolean> {
  if (!eventId) return false;
  const key = `vk:event:${eventId}`;
  const seen = await redis.get(key);
  if (seen) return true;
  await redis.set(key, "1", { ex: 3600 });
  return false;
}

async function reply(peerId: number, replyToCmid: number, text: string, keyboard?: string) {
  return await sendMessageAndGetIds(peerId, text, { replyToConversationMessageId: replyToCmid, keyboard });
}

function formatMsk(ms: number): string {
  const mskDate = new Date(ms + 3 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${mskDate.getUTCFullYear()}-${pad(mskDate.getUTCMonth() + 1)}-${pad(mskDate.getUTCDate())} ` +
    `${pad(mskDate.getUTCHours())}:${pad(mskDate.getUTCMinutes())}:${pad(mskDate.getUTCSeconds())} МСК (UTC+3)`;
}

async function chatLabelFor(peerId?: number): Promise<string> {
  if (!peerId) return "Все беседы проекта";
  const record = await getSyncRecord(peerId);
  return record ? `"${record.chatName}"` : String(peerId);
}

interface ReplyContext {
  fromId: number;
  conversationMessageId: number;
}

/** Реплай — в приоритете. Если реплая нет, пробуем явный аргумент. */
async function extractTarget(
  args: string[],
  replyToMessage: ReplyContext | null,
): Promise<{ targetId: number | null; rest: string[] }> {
  if (replyToMessage) return { targetId: replyToMessage.fromId, rest: args };
  if (args.length > 0) {
    const resolved = await resolveTargetUserId(args[0]);
    if (resolved) return { targetId: resolved, rest: args.slice(1) };
  }
  return { targetId: null, rest: args };
}

/**
 * Для /getban и /banlist: реплай/аргумент как обычно, плюс поддержка одной
 * пересланной пересылки. Если переслано НЕСКОЛЬКО сообщений — цель неоднозначна.
 * В отличие от extractTarget, здесь НЕТ дефолта на себя — если ничего не
 * указано, вызывающий должен получить "Вы не указали пользователя".
 */
// deno-lint-ignore no-explicit-any
async function extractLookupTarget(
  args: string[],
  replyToMessage: ReplyContext | null,
  fwdMessages: any[],
): Promise<{ targetId: number | null; ambiguous: boolean }> {
  if (fwdMessages && fwdMessages.length > 0) {
    if (fwdMessages.length > 1) return { targetId: null, ambiguous: true };
    return { targetId: fwdMessages[0].from_id, ambiguous: false };
  }
  const { targetId } = await extractTarget(args, replyToMessage);
  return { targetId, ambiguous: false };
}

/** Никто не может действовать на себя. Иначе — строго выше рангом (и не на бота). */
async function canActOn(peerId: number, actorId: number, targetId: number, serverName: string | null): Promise<boolean> {
  if (targetId < 0) return false;
  if (actorId === targetId) return false;
  if (isDeveloperId(actorId)) return true;
  const [actor, target] = await Promise.all([
    resolveUserRole(peerId, actorId, serverName),
    resolveUserRole(peerId, targetId, serverName),
  ]);
  return actor.weight > target.weight;
}

/** Снять бан может только тот, чей ранг СЕЙЧАС строго выше ранга банившего НА МОМЕНТ выдачи. */
async function canRemoveBan(peerId: number, actorId: number, serverName: string | null, record: BanRecord): Promise<boolean> {
  if (isDeveloperId(actorId)) return true;
  const { weight } = await resolveUserRole(peerId, actorId, serverName);
  return weight > record.byWeight;
}

async function purgeUserFromChat(peerId: number, userId: number): Promise<void> {
  for (const role of CHAT_ROLES) await removeChatRole(peerId, role, userId);
  await removeNickFor(peerId, userId);
  await clearActivity(peerId, userId);
}

async function kickAndPurge(peerId: number, userId: number): Promise<void> {
  await kickFromChat(peerId, userId);
  await purgeUserFromChat(peerId, userId);
}

// ============================= Команды настройки =============================

async function handleSetupCommand(
  peerId: number,
  fromId: number,
  cmid: number,
  serverName: string | null,
  command: string,
  args: string[],
): Promise<boolean> {
  switch (command) {
    case "/sync": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "main_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      await syncChat(peerId, fromId);
      await reply(peerId, cmid, "Синхронизация с базой данных прошла успешно!");
      return true;
    }

    case "/delsync": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "main_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      await clearSync(peerId);
      await reply(peerId, cmid, "Синхронизация с базой данных удалена.");
      return true;
    }

    case "/synclist": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "main_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      await reply(peerId, cmid, await buildSyncListMessage());
      return true;
    }

    case "/addserver": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "main_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      const name = args.join(" ");
      if (!name) { await reply(peerId, cmid, "Вы не указали название сервера"); return true; }
      const created = await addServer(name);
      await reply(peerId, cmid, created ? `Сервер «${name}» добавлен в список серверов проекта` : "Сервер с таким названием уже существует.");
      return true;
    }

    case "/delserver": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "main_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      const name = args.join(" ");
      if (!name) { await reply(peerId, cmid, "Вы не указали название сервера"); return true; }
      await removeServer(name);
      await reply(peerId, cmid, `Сервер «${name}» удален из списков серверов проекта`);
      return true;
    }

    case "/server": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "main_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      const name = args.join(" ");
      if (!name) { await reply(peerId, cmid, "Вы не указали название сервера"); return true; }
      if (!(await serverExists(name))) { await reply(peerId, cmid, "Такого сервера не существует. Сначала /addserver."); return true; }
      await bindChatToServer(peerId, name);
      await reply(peerId, cmid, `Вы привязали данную беседу в список бесед сервера «${name}»`);
      return true;
    }

    case "/servers": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "main_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      const names = await listServers();
      if (names.length === 0) { await reply(peerId, cmid, "Список серверов проекта пуст."); return true; }
      const lines = ["Список всех серверов проекта:", ""];
      for (const name of names) {
        const gas = await getServerRoleMembers(name, "main_admin");
        const gaLine = gas.length ? await nameLinkOf(gas[0]) : "отсутствует";
        lines.push(`Сервер «${name}», Главный администратор ${gaLine}`);
        const chats = await getServerChats(name);
        for (const p of chats) {
          const rec = await getSyncRecord(p);
          const ownerLink = rec?.ownerId ? await nameLinkOf(rec.ownerId) : "неизвестно";
          lines.push(`"${rec?.chatName ?? p}" | ${ownerLink} | ${p}`);
        }
        lines.push("");
      }
      await reply(peerId, cmid, lines.join("\n").trim());
      return true;
    }

    default:
      return false;
  }
}

// ============================= Назначение рангов =============================

interface RankCommandConfig {
  requiredRole: AnyRole;
  action: "add" | "remove";
  role: GlobalRole | ServerRole | ChatRole;
  scope: "global" | "server" | "chat";
}

const RANK_BASE: Record<string, Omit<RankCommandConfig, "action">> = {
  sa: { requiredRole: "developer", role: "spec_admin", scope: "global" },
  zsa: { requiredRole: "spec_admin", role: "deputy_spec_admin", scope: "global" },
  serverga: { requiredRole: "deputy_spec_admin", role: "main_admin", scope: "server" },
  ks: { requiredRole: "developer", role: "king_salad", scope: "server" },
  zks: { requiredRole: "king_salad", role: "deputy_main_admin", scope: "chat" },
  senadmin: { requiredRole: "deputy_main_admin", role: "senior_admin", scope: "chat" },
  admin: { requiredRole: "senior_admin", role: "admin", scope: "chat" },
  senmoder: { requiredRole: "admin", role: "senior_moderator", scope: "chat" },
  moder: { requiredRole: "senior_moderator", role: "moderator", scope: "chat" },
};

const RANK_COMMANDS: Record<string, RankCommandConfig> = {};
for (const [short, cfg] of Object.entries(RANK_BASE)) {
  RANK_COMMANDS[`/${short}`] = { ...cfg, action: "add" };
  RANK_COMMANDS[`/add${short}`] = { ...cfg, action: "add" };
  RANK_COMMANDS[`/del${short}`] = { ...cfg, action: "remove" };
}

async function handleRankCommand(
  peerId: number,
  fromId: number,
  cmid: number,
  serverName: string | null,
  command: string,
  args: string[],
  replyToMessage: ReplyContext | null,
): Promise<boolean> {
  const cfg = RANK_COMMANDS[command];
  if (!cfg) return false;

  if (!(await hasAtLeastRole(peerId, fromId, serverName, cfg.requiredRole))) { await reply(peerId, cmid, NO_PERMISSION); return true; }

  const { targetId } = await extractTarget(args, replyToMessage);
  if (!targetId) { await reply(peerId, cmid, NO_TARGET); return true; }
  const botGroupId = await getBotGroupId();
  if (botGroupId && targetId === -botGroupId) { await reply(peerId, cmid, NO_PERMISSION); return true; }
  const selfByDeveloper = isDeveloperId(fromId) && targetId === fromId;
  if (!selfByDeveloper && !(await canActOn(peerId, fromId, targetId, serverName))) { await reply(peerId, cmid, NO_PERMISSION); return true; }

  if (cfg.scope === "server") {
    if (!serverName) { await reply(peerId, cmid, "Эта беседа не привязана к серверу."); return true; }

    if (cfg.action === "add") {
      if (cfg.role === "main_admin") {
        // Главный администратор на сервере может быть только один.
        const currentGAs = await getServerRoleMembers(serverName, "main_admin");
        for (const oldGA of currentGAs) await removeServerRole(serverName, "main_admin", oldGA);
        await addServerRole(serverName, "main_admin", targetId);
        // ГА не может занимать должности в чатах своего же сервера.
        const chats = await getServerChats(serverName);
        for (const c of chats) for (const role of CHAT_ROLES) await removeChatRole(c, role, targetId);
      } else {
        // Королей салатников может быть несколько.
        await addServerRole(serverName, cfg.role as ServerRole, targetId);
      }
    } else {
      await removeServerRole(serverName, cfg.role as ServerRole, targetId);
    }
  } else if (cfg.scope === "chat") {
    if (cfg.action === "add") {
      // Нельзя назначить чат-роль текущему Главному администратору этого сервера.
      if (serverName) {
        const gas = await getServerRoleMembers(serverName, "main_admin");
        if (gas.includes(targetId)) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      }
      const current = await getUserChatRole(peerId, targetId);
      if (current && current !== cfg.role) await removeChatRole(peerId, current, targetId);
      await addChatRole(peerId, cfg.role as ChatRole, targetId);
    } else {
      await removeChatRole(peerId, cfg.role as ChatRole, targetId);
    }
  } else {
    if (cfg.action === "add") {
      const current = await getUserGlobalRole(targetId);
      if (current && current !== cfg.role) await removeGlobalRole(current, targetId);
      await addGlobalRole(cfg.role as GlobalRole, targetId);
    } else {
      await removeGlobalRole(cfg.role as GlobalRole, targetId);
    }
  }

  const genitive = ROLE_GENITIVE[cfg.role];
  const actorName = await nameLinkOf(fromId);
  const targetName = await nameLinkOf(targetId);
  const text = cfg.action === "add"
    ? `${actorName} выдал-(а) права ${genitive} ${targetName}`
    : `${actorName} забрал-(а) права ${genitive} у ${targetName}`;
  await reply(peerId, cmid, text);
  return true;
}

/** /zov тегает всех, включая стафф, кроме спец. и зам. спец. администратора (и разработчика). */
async function isExcludedFromZov(userId: number): Promise<boolean> {
  if (isDeveloperId(userId)) return true;
  const role = await getUserGlobalRole(userId);
  return role === "spec_admin" || role === "deputy_spec_admin";
}

// ============================= Клавиатуры =============================

function buildMuteKeyboard(targetId: number): string {
  return JSON.stringify({
    inline: true,
    buttons: [[
      { action: { type: "callback", label: "Снять мут", payload: JSON.stringify({ action: "unmute_btn", targetId }) }, color: "positive" },
      { action: { type: "callback", label: "Очистить", payload: JSON.stringify({ action: "clear_mute", targetId }) }, color: "negative" },
    ]],
  });
}

function buildTimeoutKeyboard(): string {
  return JSON.stringify({
    inline: true,
    buttons: [[
      { action: { type: "callback", label: "Выключить", payload: JSON.stringify({ action: "timeout_off" }) }, color: "negative" },
    ]],
  });
}

const NLIST_PAGE_SIZE = 20;

async function buildNlistPage(peerId: number, mode: "with" | "without", page: number) {
  const nicks = await listNicks(peerId);
  let entries: { userId: number; nick: string | null }[];
  if (mode === "with") {
    entries = nicks.map((n) => ({ userId: n.userId, nick: n.nick }));
  } else {
    const members = await getConversationMembers(peerId);
    const nickedIds = new Set(nicks.map((n) => n.userId));
    entries = members.filter((m) => m.memberId > 0 && !nickedIds.has(m.memberId)).map((m) => ({ userId: m.memberId, nick: null }));
  }

  const totalPages = Math.max(1, Math.ceil(entries.length / NLIST_PAGE_SIZE));
  const clampedPage = Math.min(Math.max(0, page), totalPages - 1);
  const pageEntries = entries.slice(clampedPage * NLIST_PAGE_SIZE, clampedPage * NLIST_PAGE_SIZE + NLIST_PAGE_SIZE);

  const header = mode === "with" ? `Пользователи с ником [${clampedPage + 1} страница]:` : `Пользователи без ников [${clampedPage + 1} страница]:`;
  const lines = [header];
  for (let i = 0; i < pageEntries.length; i++) {
    const e = pageEntries[i];
    const name = await nameLinkOf(e.userId);
    const num = clampedPage * NLIST_PAGE_SIZE + i + 1;
    lines.push(mode === "with" ? `${num}) ${name} — ${e.nick}` : `${num}) ${name}`);
  }
  if (pageEntries.length === 0) lines.push(mode === "with" ? "Пока никто не получил ник." : "Все участники уже с ником.");

  const buttons = [];
  if (clampedPage > 0) buttons.push({ action: { type: "callback", label: "Назад", payload: JSON.stringify({ action: "nlist", mode, page: clampedPage - 1 }) } });
  buttons.push({
    action: {
      type: "callback",
      label: mode === "with" ? "Без ника" : "С ником",
      payload: JSON.stringify({ action: "nlist", mode: mode === "with" ? "without" : "with", page: 0 }),
    },
  });
  if (clampedPage < totalPages - 1) buttons.push({ action: { type: "callback", label: "Вперед", payload: JSON.stringify({ action: "nlist", mode, page: clampedPage + 1 }) } });

  return { text: lines.join("\n"), keyboard: JSON.stringify({ inline: true, buttons: [buttons] }) };
}

// ============================= Основные команды =============================

async function handleCommand(
  peerId: number,
  fromId: number,
  cmid: number,
  serverName: string | null,
  command: string,
  args: string[],
  replyToMessage: ReplyContext | null,
  // deno-lint-ignore no-explicit-any
  rawMessage: any,
) {
  const botGroupId = await getBotGroupId();
  if (botGroupId && replyToMessage?.fromId === -botGroupId) {
    await reply(peerId, cmid, NO_PERMISSION);
    return;
  }

  if (await handleRankCommand(peerId, fromId, cmid, serverName, command, args, replyToMessage)) return;

  if (command === "/removerole") {
    const current = await resolveUserRole(peerId, fromId, serverName);
    if (current.role === "user" || current.role === "developer") { await reply(peerId, cmid, NO_PERMISSION); return; }
    if (current.role === "spec_admin" || current.role === "deputy_spec_admin") await removeGlobalRole(current.role, fromId);
    else if (current.role === "main_admin") {
      if (!serverName) { await reply(peerId, cmid, "Эта беседа не привязана к серверу."); return; }
      await removeServerRole(serverName, current.role, fromId);
    } else await removeChatRole(peerId, current.role, fromId);
    await reply(peerId, cmid, "Роль снята.");
    return;
  }
  switch (command) {
    case "/help": {
      const { weight } = await resolveUserRole(peerId, fromId, serverName);
      await reply(peerId, cmid, buildHelpMessage(weight));
      break;
    }

    case "/info": {
      await reply(peerId, cmid, INFO_TEXT);
      break;
    }

    case "/alt": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "senior_moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      await reply(peerId, cmid, ALT_TEXT);
      break;
    }

    case "/staff": {
      await reply(peerId, cmid, await buildStaffMessage(peerId, serverName, fromId));
      break;
    }

    case "/stats": {
      const { targetId } = await extractTarget(args, replyToMessage);
      const statsUserId = targetId ?? fromId;
      const [role, stats, nick, name, history, chatBan] = await Promise.all([
        resolveUserRole(peerId, statsUserId, serverName),
        getMessageStats(peerId, statsUserId),
        getNickFor(peerId, statsUserId),
        nameLinkOf(statsUserId),
        getBanHistory(statsUserId),
        getChatBan(peerId, statsUserId),
      ]);
      const lines = [
        "Информация о пользователе",
        name,
        `Роль: ${ROLE_LABEL[role.role]}`,
        `Блокировок: ${history.length} (все)`,
        `Блокировка чата: ${chatBan ? "Да" : "Нет"}`,
        `Ник: ${nick ?? "Нет"}`,
        `Всего сообщений: ${stats.count}`,
        `Последнее сообщение: ${stats.lastMessageMs ? formatMsk(stats.lastMessageMs) : "нет данных"}`,
      ];
      await reply(peerId, cmid, lines.join("\n"));
      break;
    }

    case "/olist": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const online = (await getOnlineMembers(peerId)).filter((u) => u.id !== fromId);
      const callerName = await nameLinkOf(fromId);
      if (online.length === 0) { await reply(peerId, cmid, `${callerName}, сейчас никого нет онлайн.`); return; }
      const lines = [`${callerName}, список пользователей онлайн`, ""];
      for (const u of online) lines.push(`[id${u.id}|${u.first_name} ${u.last_name}] — 💻`);
      lines.push(`Всего в онлайн: ${online.length}`);
      await reply(peerId, cmid, lines.join("\n"));
      break;
    }

    case "/zov": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const reason = args.join(" ");
      if (!reason) { await reply(peerId, cmid, NO_REASON); return; }
      const members = await getConversationMembers(peerId);
      const targets: number[] = [];
      for (const m of members) {
        if (m.memberId <= 0) continue;
        if (await isExcludedFromZov(m.memberId)) continue;
        targets.push(m.memberId);
      }
      const hearts = targets.map((id) => `[id${id}|🖤]`).join("");
      const text = ["🔔 Вы были вызваны администратором беседы", "", hearts, "", `❗ Причина вызова: ${reason}`].join("\n");
      await sendMessageAndGetIds(peerId, text);
      break;
    }

    // --- Баны ---

    case "/ban": {
      if (isDeveloperId(fromId)) { await reply(peerId, cmid, NO_PERMISSION); return; }

      if (!(await hasAtLeastRole(peerId, fromId, serverName, "admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId, serverName))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const reason = rest.join(" ");
      if (!reason) { await reply(peerId, cmid, NO_REASON); return; }
      const { weight } = await resolveUserRole(peerId, fromId, serverName);
      const record: BanRecord = { reason, byUserId: fromId, byWeight: weight, at: Date.now() };
      await setChatBan(peerId, targetId, record);
      await logBanEvent(targetId, { type: "ban", peerId, ...record });
      await kickAndPurge(peerId, targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} выдал-(а) блокировку чата ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
      break;
    }

    case "/unban": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      const reason = rest.join(" ");
      if (!reason) { await reply(peerId, cmid, NO_REASON); return; }
      const existing = await getChatBan(peerId, targetId);
      if (existing && !(await canRemoveBan(peerId, fromId, serverName, existing))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      await clearChatBan(peerId, targetId);
      await logBanEvent(targetId, { type: "unban", peerId, reason, byUserId: fromId, byWeight: 0, at: Date.now() });
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} снял-(а) блокировку чата у ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
      break;
    }

    case "/sban": {
      if (isDeveloperId(fromId)) { await reply(peerId, cmid, NO_PERMISSION); return; }

      if (!(await hasAtLeastRole(peerId, fromId, serverName, "deputy_main_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      if (!serverName) { await reply(peerId, cmid, "Эта беседа не привязана к серверу."); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId, serverName))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const reason = rest.join(" ");
      if (!reason) { await reply(peerId, cmid, NO_REASON); return; }
      const { weight } = await resolveUserRole(peerId, fromId, serverName);
      const record: BanRecord = { reason, byUserId: fromId, byWeight: weight, at: Date.now(), label: serverName };
      await setServerBan(serverName, targetId, record);
      await logBanEvent(targetId, { type: "sban", ...record });
      await kickFromServerChats(serverName, targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} заблокировал-(а) во всех беседах сервера ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
      break;
    }

    case "/sunban": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "main_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      if (!serverName) { await reply(peerId, cmid, "Эта беседа не привязана к серверу."); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      const reason = rest.join(" ");
      if (!reason) { await reply(peerId, cmid, NO_REASON); return; }
      const existing = await getServerBan(serverName, targetId);
      if (existing && !(await canRemoveBan(peerId, fromId, serverName, existing))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      await clearServerBan(serverName, targetId);
      await logBanEvent(targetId, { type: "sunban", reason, byUserId: fromId, byWeight: 0, at: Date.now(), label: serverName });
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} разблокировал-(а) во всех беседах сервера «${serverName}» ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
      break;
    }

    case "/gban": {
      if (isDeveloperId(fromId)) { await reply(peerId, cmid, NO_PERMISSION); return; }

      if (!(await hasAtLeastRole(peerId, fromId, serverName, "deputy_spec_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId, serverName))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const reason = rest.join(" ");
      if (!reason) { await reply(peerId, cmid, NO_REASON); return; }
      const { weight } = await resolveUserRole(peerId, fromId, serverName);
      const record: BanRecord = { reason, byUserId: fromId, byWeight: weight, at: Date.now() };
      await setGlobalBan(targetId, record);
      await logBanEvent(targetId, { type: "gban", ...record });
      await kickFromAllSyncedChats(targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} заблокировал-(а) во всех беседах проекта ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
      break;
    }

    case "/gunban": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "deputy_spec_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      const reason = rest.join(" ");
      if (!reason) { await reply(peerId, cmid, NO_REASON); return; }
      const existing = await getGlobalBan(targetId);
      if (existing && !(await canRemoveBan(peerId, fromId, serverName, existing))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      await clearGlobalBan(targetId);
      await logBanEvent(targetId, { type: "gunban", reason, byUserId: fromId, byWeight: 0, at: Date.now() });
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} разблокировал-(а) во всех беседах проекта ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
      break;
    }

    case "/getban": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "senior_moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, ambiguous } = await extractLookupTarget(args, replyToMessage, rawMessage.fwd_messages ?? []);
      if (ambiguous || !targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      const userId = targetId;
      const [globalBan, serverBans, chatBan, name] = await Promise.all([
        getGlobalBan(userId),
        getAllServerBans(userId),
        getChatBan(peerId, userId),
        nameLinkOf(userId),
      ]);

      const lines = [`Информация о блокировках ${name}`, ""];
      lines.push(`Глобальная блокировка — ${globalBan ? "Да" : "Нет"}`);
      if (globalBan) lines.push(`${await nameLinkOf(globalBan.byUserId)} | ${globalBan.reason} | ${formatMsk(globalBan.at)}`);
      lines.push("");

      lines.push(`Блокировки в беседах серверов — ${serverBans.length ? "" : "отсутствуют"}`);
      for (let i = 0; i < serverBans.length; i++) {
        const b = serverBans[i];
        lines.push(`${i + 1}) Блокировка сервера «${b.serverName}» | ${await nameLinkOf(b.record.byUserId)} | ${b.record.reason} | ${formatMsk(b.record.at)}`);
      }
      lines.push("");

      lines.push(`Блокировка в этой беседе — ${chatBan ? "" : "отсутствует"}`);
      if (chatBan) lines.push(`${await nameLinkOf(chatBan.byUserId)} | ${chatBan.reason} | ${formatMsk(chatBan.at)}`);

      await reply(peerId, cmid, lines.join("\n"));
      break;
    }

    case "/sbanlist": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "senior_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const keys = await scanKeys("b2:sban:*:*");
      if (keys.length === 0) { await reply(peerId, cmid, "Список серверных блокировок пуст."); return; }
      const lines = ["Список серверных блокировок:", ""];
      for (const key of keys) {
        const parts = key.split(":");
        const serverKey = parts[2] ?? "";
        const userId = Number(parts[3]);
        if (!serverKey || !userId) continue;
        const record = await getServerBan(serverKey, userId);
        if (!record) continue;
        lines.push(
          "Сервер: " + serverKey,
          "Пользователь: " + await nameLinkOf(userId),
          "Выдал-(а): " + await nameLinkOf(record.byUserId),
          "Причина: " + record.reason,
          "Дата: " + formatMsk(record.at),
          "",
        );
      }
      await reply(peerId, cmid, lines.join("\n").trim());
      break;
    }

    case "/gbanlist": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "deputy_main_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const keys = await scanKeys("b2:gban:*");
      if (keys.length === 0) { await reply(peerId, cmid, "Список глобальных блокировок пуст."); return; }
      const lines = ["Список глобальных блокировок:", ""];
      for (const key of keys) {
        const userId = Number(key.split(":")[2]);
        if (!userId) continue;
        const record = await getGlobalBan(userId);
        if (!record) continue;
        lines.push(
          "Пользователь: " + await nameLinkOf(userId),
          "Выдал-(а): " + await nameLinkOf(record.byUserId),
          "Причина: " + record.reason,
          "Дата: " + formatMsk(record.at),
          "",
        );
      }
      await reply(peerId, cmid, lines.join("\n").trim());
      break;
    }

    case "/banlist": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, ambiguous } = await extractLookupTarget(args, replyToMessage, rawMessage.fwd_messages ?? []);
      if (ambiguous || !targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      const userId = targetId;
      const [history, name] = await Promise.all([getBanHistory(userId), nameLinkOf(userId)]);
      if (history.length === 0) { await reply(peerId, cmid, `Список блокировок пользователя ${name}:\n\nИстория пуста.`); return; }
      const lines = [`Список блокировок пользователя ${name}:`, ""];
      for (const h of history.slice(0, 20)) {
        const label = await chatLabelFor(h.peerId ?? undefined);
        lines.push(`${h.type} | ${h.label ?? label} | ${await nameLinkOf(h.byUserId)} | ${h.reason} | ${formatMsk(h.at)}`);
      }
      await reply(peerId, cmid, lines.join("\n"));
      break;
    }

    // --- Кики ---

    case "/kick": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "senior_moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId, serverName))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const reason = rest.join(" ") || "Не указана";
      await logBanEvent(targetId, { type: "kick", peerId, reason, byUserId: fromId, byWeight: 0, at: Date.now() });
      await kickAndPurge(peerId, targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} исключил-(а) из этой беседы ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
      break;
    }

    case "/skick": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "deputy_main_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      if (!serverName) { await reply(peerId, cmid, "Эта беседа не привязана к серверу."); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId, serverName))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const reason = rest.join(" ");
      if (!reason) { await reply(peerId, cmid, NO_REASON); return; }
      await logBanEvent(targetId, { type: "skick", reason, byUserId: fromId, byWeight: 0, at: Date.now(), label: serverName });
      await kickFromServerChats(serverName, targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} исключил-(а) во всех беседах сервера «${serverName}» ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
      break;
    }

    case "/gkick": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "deputy_spec_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId, serverName))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const reason = rest.join(" ");
      if (!reason) { await reply(peerId, cmid, NO_REASON); return; }
      await logBanEvent(targetId, { type: "gkick", reason, byUserId: fromId, byWeight: 0, at: Date.now() });
      await kickFromAllSyncedChats(targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} исключил-(а) во всех беседах проекта ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
      break;
    }

    // --- Мут / тайм-аут / очистка ---

    case "/mute": {
      if (isDeveloperId(fromId)) { await reply(peerId, cmid, NO_PERMISSION); return; }
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "senior_moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId, serverName))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const minutes = Number(rest[0]);
      if (!minutes) { await reply(peerId, cmid, NO_MUTE_TIME); return; }
      const reason = rest.slice(1).join(" ");
      if (!reason) { await reply(peerId, cmid, NO_REASON); return; }

      const expiresAt = Date.now() + minutes * 60000;
      const text = [
        `${await nameLinkOf(fromId)} замьютил-(а) ${await nameLinkOf(targetId)}`,
        `Причина: ${reason}`,
        `Мут выдан до: ${formatMsk(expiresAt)}`,
      ].join("\n");
      const ids = await reply(peerId, cmid, text, buildMuteKeyboard(targetId));

      const muteRecord: MuteRecord = {
        reason,
        byUserId: fromId,
        expiresAt,
        botCmid: ids?.conversationMessageId,
        moderatorCmid: cmid,
        targetCmid: replyToMessage?.conversationMessageId,
      };
      await setMute(peerId, targetId, muteRecord);
      break;
    }

    case "/unmute": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "senior_moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      await clearMute(peerId, targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} размьютил-(а) ${await nameLinkOf(targetId)}`);
      break;
    }

    case "/timeout": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "senior_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const active = await isTimeoutActive(peerId);
      if (active) {
        await setTimeoutMode(peerId, false);
        await reply(peerId, cmid, `${await nameLinkOf(fromId)} выключил режим тишины`);
      } else {
        await setTimeoutMode(peerId, true);
        await reply(peerId, cmid, `${await nameLinkOf(fromId)} включил режим тишины`, buildTimeoutKeyboard());
      }
      break;
    }

    case "/clear": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "senior_moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }

      // deno-lint-ignore no-explicit-any
      const fwd: any[] = rawMessage.fwd_messages ?? [];
      const targets: { fromId: number; cmid: number }[] = [];
      if (fwd.length > 0) {
        for (const f of fwd) if (f.conversation_message_id) targets.push({ fromId: f.from_id, cmid: f.conversation_message_id });
      } else if (replyToMessage) {
        targets.push({ fromId: replyToMessage.fromId, cmid: replyToMessage.conversationMessageId });
      }

      if (targets.length === 0) { await reply(peerId, cmid, NO_TARGET); return; }

      for (const t of targets) {
        if (t.fromId !== fromId && !(await canActOn(peerId, fromId, t.fromId, serverName))) {
          await reply(peerId, cmid, "Вы не можете очистить сообщения данного пользователя!");
          return;
        }
      }

      const cmids = targets.map((t) => t.cmid).join(",");
      await callVkApi("messages.delete", { peer_id: String(peerId), cmids, delete_for_all: "1" });
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} очистил-(а) сообщение-(я)!`);
      break;
    }

    // --- Ники ---

    case "/setnick": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "senior_moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId, serverName))) { await reply(peerId, cmid, "Вы не можете менять ник данному пользователю!"); return; }
      const nick = rest.join(" ");
      if (!nick) { await reply(peerId, cmid, "Вы не указали ник"); return; }
      await setNickFor(peerId, targetId, nick);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} сменил-(а) ник у ${await nameLinkOf(targetId)}\nНовый ник: ${nick}`);
      break;
    }

    case "/removenick": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "senior_moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId, serverName))) { await reply(peerId, cmid, "Вы не можете снять ник данного пользователя!"); return; }
      const existing = await getNickFor(peerId, targetId);
      if (!existing) { await reply(peerId, cmid, "У Пользователя нет ника"); return; }
      await removeNickFor(peerId, targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} убрал-(а) ник у ${await nameLinkOf(targetId)}`);
      break;
    }

    case "/getnick": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "senior_moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      const nick = await getNickFor(peerId, targetId);
      await reply(peerId, cmid, nick ? `Ник пользователя — ${nick}` : "У Пользователя нет ника");
      break;
    }

    case "/getacc": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "senior_moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const nick = args.join(" ");
      if (!nick) { await reply(peerId, cmid, "Вы не указали ник"); return; }
      const userId = await findUserIdByNick(peerId, nick);
      await reply(peerId, cmid, userId ? `Ник ${nick} принадлежит — ${await nameLinkOf(userId)}` : "Ник не найден.");
      break;
    }

    case "/nlist": {
      if (!(await hasAtLeastRole(peerId, fromId, serverName, "senior_moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const page = await buildNlistPage(peerId, "with", 0);
      await reply(peerId, cmid, page.text, page.keyboard);
      break;
    }

    default:
      break;
  }
}

// ============================= Нажатия кнопок =============================

// deno-lint-ignore no-explicit-any
async function handleMessageEvent(body: any) {
  const obj = body.object;
  const peerId = obj.peer_id;
  const userId = obj.user_id;
  if (!isChatPeer(peerId)) return;

  await callVkApi("messages.sendMessageEventAnswer", { event_id: obj.event_id, user_id: String(userId), peer_id: String(peerId) });

  // deno-lint-ignore no-explicit-any
  let payload: any;
  try {
    payload = typeof obj.payload === "string" ? JSON.parse(obj.payload) : obj.payload ?? {};
  } catch {
    return;
  }

  const serverName = await getChatServer(peerId);

  if (payload.action === "timeout_off") {
    if (!(await hasAtLeastRole(peerId, userId, serverName, "admin"))) return;
    await setTimeoutMode(peerId, false);
    await callVkApi("messages.edit", {
      peer_id: String(peerId),
      conversation_message_id: String(obj.conversation_message_id),
      message: `${await nameLinkOf(userId)} выключил режим тишины`,
    });
    return;
  }

  if (payload.action === "unmute_btn") {
    if (!(await hasAtLeastRole(peerId, userId, serverName, "senior_moderator"))) return;
    await clearMute(peerId, payload.targetId);
    await callVkApi("messages.edit", {
      peer_id: String(peerId),
      conversation_message_id: String(obj.conversation_message_id),
      message: `${await nameLinkOf(userId)} размьютил-(а) ${await nameLinkOf(payload.targetId)}`,
    });
    return;
  }

  if (payload.action === "clear_mute") {
    if (!(await hasAtLeastRole(peerId, userId, serverName, "senior_moderator"))) return;
    const record = await getMute(peerId, payload.targetId);
    if (!record) return;

    const cmids = [record.moderatorCmid, record.targetCmid].filter(Boolean).join(",");
    if (cmids) await callVkApi("messages.delete", { peer_id: String(peerId), cmids, delete_for_all: "1" });

    if (record.botCmid) {
      const text = [
        `${await nameLinkOf(record.byUserId)} замьютил-(а) ${await nameLinkOf(payload.targetId)}`,
        `Причина: ${record.reason}`,
        `Мут выдан до: ${formatMsk(record.expiresAt)}`,
      ].join("\n");
      // Редактируем без forward/reply и без клавиатуры — сообщение становится обычным,
      // не привязанным к удалённым сообщениям.
      await callVkApi("messages.edit", {
        peer_id: String(peerId),
        conversation_message_id: String(record.botCmid),
        message: text,
        keyboard: JSON.stringify({ inline: true, buttons: [] }),
      });
    }
    return;
  }

  if (payload.action === "nlist") {
    if (!(await hasAtLeastRole(peerId, userId, serverName, "moderator"))) return;
    const page = await buildNlistPage(peerId, payload.mode, payload.page);
    await callVkApi("messages.edit", {
      peer_id: String(peerId),
      conversation_message_id: String(obj.conversation_message_id),
      message: page.text,
      keyboard: page.keyboard,
    });
  }
}

// ============================= Новые сообщения =============================

// deno-lint-ignore no-explicit-any
async function handleMessageNew(body: any) {
  const message = body.object.message;
  if (message.out === 1) return;

  const peerId = message.peer_id;
  const fromId = message.from_id;
  const text = (message.text ?? "").trim();

  if (!isChatPeer(peerId)) {
    const normalized = text.replace(/^[+!]/, "/").toLowerCase();
    console.log(`[DEBUG] ЛС от ${fromId}: text="${text}" normalized="${normalized}" isDeveloper=${isDeveloperId(fromId)}`);
    if (normalized === "/resetdata" && isDeveloperId(fromId)) {
      const keys = await scanKeys("b2:*");
      console.log(`[DEBUG] /resetdata: найдено ключей ${keys.length}`);
      if (keys.length > 0) await redis.del(...keys);
      await sendMessageAndGetIds(peerId, `Удалено ключей: ${keys.length}`);
    }
    return;
  }

  const cmid = message.conversation_message_id;
  const serverName = await getChatServer(peerId);

  const activeBan = await getActiveBanForChat(peerId, fromId);
  if (activeBan) {
    await callVkApi("messages.delete", { peer_id: String(peerId), cmids: String(cmid), delete_for_all: "1" });
    await kickAndPurge(peerId, fromId);
    await sendMessageAndGetIds(peerId, `${await nameLinkOf(fromId)} исключён-(а) — данный пользователь находится в блокировке.`);
    return;
  }

  if (await isMuted(peerId, fromId)) {
    await callVkApi("messages.delete", { peer_id: String(peerId), cmids: String(cmid), delete_for_all: "1" });
    return;
  }

  if (await isTimeoutActive(peerId)) {
    if (!(await hasAtLeastRole(peerId, fromId, serverName, "senior_moderator"))) {
      await callVkApi("messages.delete", { peer_id: String(peerId), cmids: String(cmid), delete_for_all: "1" });
      return;
    }
  }

  const replyToMessage: ReplyContext | null = message.reply_message
    ? { fromId: message.reply_message.from_id, conversationMessageId: message.reply_message.conversation_message_id }
    : null;

  if (text.length > 1 && ["/", "+", "!"].includes(text[0])) {
    let [command, ...args] = text.split(/\s+/);
    command = "/" + command.slice(1).toLowerCase();

    const altTarget = ALT_MAP[command.slice(1)];
    if (altTarget) command = altTarget;

    if (!isDeveloperId(fromId) && !(await isSynced(peerId)) && command !== "/sync") return;

    const handledAsSetup = await handleSetupCommand(peerId, fromId, cmid, serverName, command, args);
    if (handledAsSetup) return;

    if (!isDeveloperId(fromId) && !(await isChatConfigured(peerId)) && command !== "/help") {
      await reply(peerId, cmid, await getConfigStatusMessage(peerId));
      return;
    }

    await handleCommand(peerId, fromId, cmid, serverName, command, args, replyToMessage, message);
    return;
  }

  if (await isChatConfigured(peerId)) {
    await trackMessage(peerId, fromId);
    const shouldKick = await trackFloodAndShouldKick(peerId, fromId, text);
    if (shouldKick) {
      await kickAndPurge(peerId, fromId);
      await sendMessageAndGetIds(peerId, `${await nameLinkOf(fromId)} исключён-(а) за флуд.`);
    }
  }
}

// ============================= Добавление / выход из беседы =============================

// deno-lint-ignore no-explicit-any
async function handleChatInviteUser(body: any) {
  const obj = body.object;
  const peerId: number | undefined = obj.chat_id ? obj.chat_id + 2_000_000_000 : obj.peer_id;
  const userId: number | undefined = obj.user_id;
  if (!peerId || !userId) return;

  if (userId < 0) {
    const botGroupId = await getBotGroupId();
    if (botGroupId && -userId === botGroupId) {
      await sendMessageAndGetIds(peerId, "Бот добавлен в беседу, выдайте мне администратора, а затем введите /sync для синхронизации c базой данных!");
    }
    return;
  }

  const serverName = await getChatServer(peerId);
  const initiatorId: number | undefined = obj.initiator_id;
  if (initiatorId && initiatorId !== userId && !(await hasAtLeastRole(peerId, initiatorId, serverName, "moderator"))) {
    await kickFromChat(peerId, userId);
    return;
  }

  const ban = await getActiveBanForChat(peerId, userId);
  if (ban) {
    await kickFromChat(peerId, userId);
    return;
  }

  if (!(await isChatConfigured(peerId))) return;

  const infoMap = await getUsersInfo([userId]);
  const firstName = infoMap.get(userId)?.first_name ?? `id${userId}`;

  await sendMessageAndGetIds(
    peerId,
    [
      `@id${userId} (${firstName}), добро пожаловать в беседу!`,
      "Не забудь прочитать закреплённое сообщение!",
      'Посмотреть ссылки на официальные ресурсы проекта: «/info»',
    ].join("\n"),
  );
}

/** Самостоятельный выход из беседы — очищаем данные пользователя в этом чате. */
// deno-lint-ignore no-explicit-any
async function handleChatKickUser(body: any) {
  const obj = body.object;
  const peerId: number | undefined = obj.chat_id ? obj.chat_id + 2_000_000_000 : obj.peer_id;
  const userId: number | undefined = obj.user_id;
  if (!peerId || !userId) return;
  await purgeUserFromChat(peerId, userId);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Bot 2 (astana-manager) is running", { status: 200 });
  }

  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  if (body.type === "confirmation") {
    return new Response(VK_CONFIRMATION, { status: 200 });
  }

  if (VK_SECRET && body.secret !== undefined && body.secret !== VK_SECRET) {
    return new Response("invalid secret", { status: 403 });
  }

  if (await alreadyProcessed(body.event_id)) {
    return new Response("ok", { status: 200 });
  }

  try {
    if (body.type === "message_new") {
      await handleMessageNew(body);
    } else if (body.type === "message_event") {
      await handleMessageEvent(body);
    } else if (body.type === "chat_invite_user") {
      await handleChatInviteUser(body);
    } else if (body.type === "chat_kick_user") {
      await handleChatKickUser(body);
    }
  } catch (e) {
    console.error("Ошибка обработки события:", e);
  }

  return new Response("ok", { status: 200 });
});
