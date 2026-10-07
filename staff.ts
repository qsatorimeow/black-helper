// /staff — список рангов беседы (с учётом сервера). /help и /alt — справка.
import { getConversationMembers, getUsersInfo, nameLinkOfAny, profileLink } from "./vk.ts";
import {
  type AnyRole,
  CHAT_ROLES,
  getChatRoleMembers,
  getGlobalRoleMembers,
  getServerRoleMembers,
  ROLE_WEIGHT,
} from "./roles.ts";

export async function buildStaffMessage(peerId: number, serverName: string | null): Promise<string> {
  const [members, specAdmins, deputySpecAdmins, mainAdmins, ...chatRoleMembers] = await Promise.all([
    getConversationMembers(peerId),
    getGlobalRoleMembers("spec_admin"),
    getGlobalRoleMembers("deputy_spec_admin"),
    serverName ? getServerRoleMembers(serverName, "main_admin") : Promise.resolve([]),
    ...CHAT_ROLES.map((role) => getChatRoleMembers(peerId, role)),
  ]);

  const owner = members.find((m) => m.isOwner);
  const positiveIds = [...specAdmins, ...deputySpecAdmins, ...mainAdmins, ...chatRoleMembers.flat()];
  const infoMap = await getUsersInfo(positiveIds);
  const nameOf = (id: number) => {
    const info = infoMap.get(id);
    return profileLink(id, info ? `${info.first_name} ${info.last_name}` : `id${id}`);
  };

  const section = (title: string, ids: number[], emptyWord: string) => {
    return `${title}:\n${ids.length ? ids.map((id) => nameOf(id)).join("\n") : emptyWord}`;
  };

  const lines: string[] = [];
  lines.push(`Владелец беседы — ${owner ? await nameLinkOfAny(owner.memberId) : "отсутствует"}`);
  lines.push("");
  lines.push(section("Спец администраторы", specAdmins, "Отсутствует"));
  lines.push("");
  lines.push(section("Зам.Спец администратора", deputySpecAdmins, "Отсутствуют"));
  lines.push("");
  lines.push(section("Главный администратор", mainAdmins, "Отсутствует"));
  lines.push("");

  const chatSectionLabels: Record<string, string> = {
    deputy_main_admin: "Зам.Главного администратора",
    senior_admin: "Старшие администраторы",
    admin: "Администраторы",
    senior_moderator: "Старшие модераторы",
    moderator: "Модераторы",
  };
  const chatSectionEmpty: Record<string, string> = {
    deputy_main_admin: "Отсутствует",
    senior_admin: "Отсутствуют",
    admin: "Отсутствует",
    senior_moderator: "Отсутствуют",
    moderator: "Отсутствуют",
  };

  CHAT_ROLES.forEach((role, i) => {
    lines.push(section(chatSectionLabels[role], chatRoleMembers[i], chatSectionEmpty[role]));
    lines.push("");
  });

  return lines.join("\n").trim();
}

// --- /help ---

interface CommandInfo {
  cmd: string;
  description: string;
  minRole: AnyRole;
}

export const COMMAND_REGISTRY: CommandInfo[] = [
  { cmd: "/stats", description: "статистика профиля", minRole: "user" },
  { cmd: "/help", description: "список доступных вам команд", minRole: "user" },
  { cmd: "/info", description: "официальные ресурсы проекта", minRole: "user" },

  { cmd: "/staff", description: "список рангов беседы", minRole: "moderator" },
  { cmd: "/setnick", description: "назначить ник", minRole: "moderator" },
  { cmd: "/removenick", description: "убрать ник", minRole: "moderator" },
  { cmd: "/getacc", description: "найти профиль по нику", minRole: "moderator" },
  { cmd: "/getnick", description: "узнать ник пользователя", minRole: "moderator" },
  { cmd: "/nlist", description: "все ники в чате", minRole: "moderator" },
  { cmd: "/getban", description: "блокировки пользователя", minRole: "moderator" },
  { cmd: "/alt", description: "альтернативные названия команд", minRole: "moderator" },

  { cmd: "/addmoder", description: "назначить модератора", minRole: "senior_moderator" },
  { cmd: "/delmoder", description: "снять модератора", minRole: "senior_moderator" },
  { cmd: "/mute", description: "замутить пользователя", minRole: "senior_moderator" },
  { cmd: "/unmute", description: "снять мут", minRole: "senior_moderator" },
  { cmd: "/clear", description: "удалить сообщение(я)", minRole: "senior_moderator" },

  { cmd: "/addsenmoder", description: "назначить старшего модератора", minRole: "admin" },
  { cmd: "/delsenmoder", description: "снять старшего модератора", minRole: "admin" },
  { cmd: "/timeout", description: "режим тишины в чате", minRole: "admin" },
  { cmd: "/olist", description: "список пользователей онлайн", minRole: "admin" },
  { cmd: "/zov", description: "вызвать всех участников (не стафф)", minRole: "admin" },

  { cmd: "/ban", description: "блокировка в этой беседе", minRole: "senior_admin" },
  { cmd: "/addadmin", description: "назначить администратора", minRole: "senior_admin" },
  { cmd: "/deladmin", description: "снять администратора", minRole: "senior_admin" },
  { cmd: "/banlist", description: "история блокировок пользователя", minRole: "senior_admin" },

  { cmd: "/sban", description: "блокировка во всех беседах сервера", minRole: "deputy_main_admin" },
  { cmd: "/unban", description: "снять блокировку этой беседы", minRole: "deputy_main_admin" },
  { cmd: "/addsenadmin", description: "назначить старшего администратора", minRole: "deputy_main_admin" },
  { cmd: "/delsenadmin", description: "снять старшего администратора", minRole: "deputy_main_admin" },
  { cmd: "/skick", description: "кик из всех бесед сервера", minRole: "deputy_main_admin" },

  { cmd: "/sunban", description: "снять блокировку сервера", minRole: "main_admin" },
  { cmd: "/addzga", description: "назначить зам. главного администратора", minRole: "main_admin" },
  { cmd: "/delzga", description: "снять зам. главного администратора", minRole: "main_admin" },

  { cmd: "/sync", description: "синхронизация чата с базой", minRole: "deputy_spec_admin" },
  { cmd: "/delsync", description: "удалить синхронизацию", minRole: "deputy_spec_admin" },
  { cmd: "/synclist", description: "список синхронизированных чатов", minRole: "deputy_spec_admin" },
  { cmd: "/addserverga", description: "назначить главного администратора сервера", minRole: "deputy_spec_admin" },
  { cmd: "/delserverga", description: "снять главного администратора сервера", minRole: "deputy_spec_admin" },
  { cmd: "/gban", description: "глобальная блокировка", minRole: "deputy_spec_admin" },
  { cmd: "/gunban", description: "снять глобальную блокировку", minRole: "deputy_spec_admin" },
  { cmd: "/gkick", description: "глобальный кик", minRole: "deputy_spec_admin" },

  { cmd: "/addserver", description: "добавить сервер проекта", minRole: "spec_admin" },
  { cmd: "/delserver", description: "удалить сервер проекта", minRole: "spec_admin" },
  { cmd: "/server", description: "привязать беседу к серверу", minRole: "spec_admin" },
  { cmd: "/servers", description: "список всех серверов проекта", minRole: "spec_admin" },
  { cmd: "/addzsa", description: "назначить зам. спец. админа", minRole: "spec_admin" },
  { cmd: "/delzsa", description: "снять зам. спец. админа", minRole: "spec_admin" },

  { cmd: "/addsa", description: "назначить спец. админа", minRole: "developer" },
  { cmd: "/delsa", description: "снять спец. админа", minRole: "developer" },
  { cmd: "/addks", description: "назначить короля салатников", minRole: "developer" },
  { cmd: "/delks", description: "снять короля салатников", minRole: "developer" },
  { cmd: "/resetdata", description: "полная очистка данных (только в ЛС боту)", minRole: "developer" },
];

export function buildHelpMessage(userWeight: number): string {
  const available = COMMAND_REGISTRY.filter((c) => userWeight >= ROLE_WEIGHT[c.minRole]);
  const lines = ["Список доступных вам команд:", ""];
  for (const c of available) lines.push(`${c.cmd} — ${c.description}`);
  return lines.join("\n");
}

export const ALT_TEXT = [
  "Альтернативные команды",
  "",
  "Команды модераторов:",
  "/alt — альт",
  "/clear — чистка",
  "/staff — стафф",
  "/getnick — gnick, никлист, гетник",
  "/setnick — snick",
  "/removenick — rnick",
  "/nlist — ники",
  "/getacc — аккаунт, гетакк",
  "/getban — чекбан, гетбан",
  "/kick — кик, кикнуть",
  "/mute — мут, заткнуть",
  "/unmute — размут, разоткнуть",
  "/stats — стата, статс",
].join("\n");

export const ALT_MAP: Record<string, string> = {
  "альт": "/alt",
  "чистка": "/clear",
  "стафф": "/staff",
  "gnick": "/getnick",
  "никлист": "/getnick",
  "гетник": "/getnick",
  "snick": "/setnick",
  "rnick": "/removenick",
  "ники": "/nlist",
  "аккаунт": "/getacc",
  "гетакк": "/getacc",
  "чекбан": "/getban",
  "гетбан": "/getban",
  "кик": "/kick",
  "кикнуть": "/kick",
  "мут": "/mute",
  "заткнуть": "/mute",
  "размут": "/unmute",
  "разоткнуть": "/unmute",
  "стата": "/stats",
  "статс": "/stats",
  "тишина": "/timeout",
  "olist": "/olist",
  "онлайн": "/olist",
  "зов": "/zov",
};
