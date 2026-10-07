import { getConversationMembers, getUsersInfo, nameLinkOfAny, profileLink } from "./vk.ts";
import { type AnyRole, CHAT_ROLES, getChatRoleMembers, getServerRoleMembers, ROLE_WEIGHT, resolveUserRole } from "./roles.ts";

interface CommandInfo { cmd: string; description: string; minRole: AnyRole; }

export const COMMAND_REGISTRY: CommandInfo[] = [
  {cmd:"/stats",description:"статистика профиля",minRole:"user"},
  {cmd:"/help",description:"список доступных вам команд",minRole:"user"},
  {cmd:"/info",description:"официальные ресурсы проекта",minRole:"user"},
  {cmd:"/staff",description:"список рангов беседы",minRole:"user"},
  {cmd:"/alt",description:"альтернативные названия команд",minRole:"user"},
  {cmd:"/setnick",description:"назначить ник",minRole:"senior_moderator"},
  {cmd:"/removenick",description:"убрать ник",minRole:"senior_moderator"},
  {cmd:"/removerole",description:"убрать роль",minRole:"senior_moderator"},
  {cmd:"/getacc",description:"найти профиль/профили по нику/никам",minRole:"senior_moderator"},
  {cmd:"/getnick",description:"узнать ник пользователя",minRole:"senior_moderator"},
  {cmd:"/nlist",description:"все ники в чате",minRole:"senior_moderator"},
  {cmd:"/getban",description:"блокировки пользователя",minRole:"senior_moderator"},
  {cmd:"/addisp",description:"назначить модератора",minRole:"senior_moderator"},
  {cmd:"/mute",description:"замутить пользователя",minRole:"senior_moderator"},
  {cmd:"/unmute",description:"снять мут",minRole:"senior_moderator"},
  {cmd:"/clear",description:"удалить сообщение(я)",minRole:"senior_moderator"},
  {cmd:"/addsenmoder",description:"назначить старшего модератора",minRole:"admin"},
  {cmd:"/ban",description:"блокировка в этой беседе",minRole:"admin"},
  {cmd:"/addms",description:"назначить администратора",minRole:"admin"},
  {cmd:"/banlist",description:"блокировки пользователя",minRole:"admin"},
  {cmd:"/onlinelist",description:"список пользователей онлайн",minRole:"admin"},
  {cmd:"/zov",description:"вызвать всех участников",minRole:"admin"},
  {cmd:"/unban",description:"снять блокировку этой беседы",minRole:"admin"},
  {cmd:"/timeout",description:"режим тишины в чате",minRole:"senior_admin"},
  {cmd:"/sban",description:"блокировка во всех беседах сервера",minRole:"senior_admin"},
  {cmd:"/skick",description:"кик из всех бесед сервера",minRole:"senior_admin"},
  {cmd:"/sunban",description:"снять блокировку сервера",minRole:"senior_admin"},
  {cmd:"/addsenadmin",description:"назначить старшего администратора",minRole:"deputy_main_admin"},
  {cmd:"/gban",description:"глобальная блокировка",minRole:"deputy_main_admin"},
  {cmd:"/gunban",description:"снять глобальную блокировку",minRole:"deputy_main_admin"},
  {cmd:"/gbanpl",description:"глобальная боокировка #2",minRole:"deputy_main_admin"},
  {cmd:"/gunbanpl",description:"снять глобальную блокировку #2",minRole:"deputy_main_admin"},
  {cmd:"/gkick",description:"глобальный кик",minRole:"deputy_main_admin"},
  {cmd:"/sync",description:"синхронизация чата с базой",minRole:"king_salad"},
  {cmd:"/delsync",description:"удалить синхронизацию",minRole:"king_salad"},
  {cmd:"/synclist",description:"список синхронизированных чатов",minRole:"king_salad"},
  {cmd:"/addserver",description:"добавить сервер проекта",minRole:"king_salad"},
  {cmd:"/delserver",description:"удалить сервер проекта",minRole:"king_salad"},
  {cmd:"/server",description:"привязать беседу к серверу",minRole:"king_salad"},
  {cmd:"/servers",description:"список всех серверов проекта",minRole:"king_salad"},
  {cmd:"/addzks",description:"назначить зам. короля салатности",minRole:"king_salad"},
  {cmd:"/resetdata",description:"полная очистка данных",minRole:"developer"},
];

const HELP_SECTIONS: Array<{ role: AnyRole; title: string }> = [
  { role: "moderator", title: "Команды испытательных сроков:" },
  { role: "senior_moderator", title: "Команды старших модераторов:" },
  { role: "admin", title: "Команды мега салатников:" },
  { role: "senior_admin", title: "Команды старших администраторов:" },
  { role: "deputy_main_admin", title: "Команды зам. короля салатников:" },
  { role: "king_salad", title: "Команды короля салатников:" },
  { role: "developer", title: "Команды разработчика:" },
];

export function buildHelpMessage(userWeight:number):string {
  const lines: string[] = [];
  for (const section of HELP_SECTIONS) {
    if (userWeight < ROLE_WEIGHT[section.role]) continue;
    const commands = COMMAND_REGISTRY.filter((c) => c.minRole === section.role && userWeight >= ROLE_WEIGHT[c.minRole]);
    if (commands.length === 0) continue;
    if (lines.length > 0) lines.push("");
    lines.push(section.title);
    for (const c of commands) lines.push(c.cmd + " — " + c.description);
  }
  return lines.join("\n");
}
export const ALT_TEXT = [
  "Альтернативные вызовы команд:",
  "stats - стата, статс","help - помощь","info - инфо","staff - стафф","alt - альт",
  "setnick - snick","removenick - rnick","removerole - rrole","getacc - аккаунт",
  "getnick - gnick, никлист","nlist - ники","getban - чекбан, гетбан","addisp - исп",
  "mute - мут","unmute - снятьмут","clear - чистка","addsenmoder - senmoder",
  "ban - бан","addms - ms, мс","banlist - банлист",
  "onlinelist - olist, онлайнлист, олист","zov - зов","timeout - тишина","addsenadmin - senadmin"
].join("\n");

export const ALT_MAP: Record<string,string> = {
  "стата":"/stats","статс":"/stats","помощь":"/help","инфо":"/info","стафф":"/staff","альт":"/alt",
  "snick":"/setnick","rnick":"/removenick","rrole":"/removerole","аккаунт":"/getacc",
  "gnick":"/getnick","никлист":"/getnick","ники":"/nlist","чекбан":"/getban","гетбан":"/getban",
  "исп":"/addisp","мут":"/mute","снятьмут":"/unmute","чистка":"/clear","senmoder":"/addsenmoder",
  "бан":"/ban","ms":"/addms","мс":"/addms","банлист":"/banlist",
  "olist":"/onlinelist","онлайнлист":"/onlinelist","олист":"/onlinelist","зов":"/zov",
  "тишина":"/timeout","senadmin":"/addsenadmin"
};

export async function buildStaffMessage(peerId: number, serverName: string | null, viewerId: number): Promise<string> {
  const viewer = await resolveUserRole(peerId, viewerId, serverName);
  const [members, mainAdmins, kings, ...chatRoleMembers] = await Promise.all([
    getConversationMembers(peerId),
    serverName ? getServerRoleMembers(serverName, "main_admin") : Promise.resolve([]),
    serverName ? getServerRoleMembers(serverName, "king_salad") : Promise.resolve([]),
    ...CHAT_ROLES.map((role) => getChatRoleMembers(peerId, role)),
  ]);

  const owner = members.find((m) => m.isOwner);
  const ids = [...mainAdmins, ...kings, ...chatRoleMembers.flat()];
  const infoMap = await getUsersInfo(ids);
  const nameOf = (id: number) => {
    const info = infoMap.get(id);
    return profileLink(id, info ? info.first_name + " " + info.last_name : "id" + id);
  };

  const sections: [string, AnyRole, number[], string][] = [
    ["Короли салатников", "king_salad", serverName ? await getServerRoleMembers(serverName, "king_salad") : [], "Отсутствует"],
    ["Зам. короля салатников", "deputy_main_admin", chatRoleMembers[0], "Отсутствует"],
    ["Старшие администраторы", "senior_admin", chatRoleMembers[1], "Отсутствуют"],
    ["Мега салатники", "admin", chatRoleMembers[2], "Отсутствует"],
    ["Старшие модераторы", "senior_moderator", chatRoleMembers[3], "Отсутствуют"],
    ["Испытательные сроки", "moderator", chatRoleMembers[4], "Отсутствуют"],
  ];

  const lines = [
    "Владелец беседы — " + (owner ? await nameLinkOfAny(owner.memberId) : "Отсутствуют"),
    "",
  ];

  for (const [title, role, userIds, empty] of sections) {
    if (ROLE_WEIGHT[role] <= viewer.weight) {
      lines.push(title + ":", userIds.length ? userIds.map(nameOf).join("\n") : empty, "");
    }
  }

  return lines.join("\n").trim();
}
