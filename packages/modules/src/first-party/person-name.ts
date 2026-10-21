/** 身份称呼只使用该回合冻结的实体名与平台昵称。关系与偏好由 Memory 提供。 */
export interface FrozenPersonName {
  personInformationId: string;
  speakerKey: string;
  initialName: string;
  platform?: string;
  adapterId?: string;
}
export function displayPersonName(name: string, accountId: string): string {
  const value = name.trim() || accountId;
  return value === accountId ? accountId : `${value}（${accountId}）`;
}
export function frozenSpeakerName(
  source: {
    senderId: string;
    platform?: string;
    adapterId?: string;
    sender?: { nickname?: string };
  },
  names: readonly FrozenPersonName[],
): string {
  const match = names.find(
    (item) =>
      item.speakerKey === `speaker:${source.senderId}` &&
      (!item.platform ||
        (item.platform === source.platform &&
          item.adapterId === source.adapterId)),
  );
  return displayPersonName(
    match?.initialName || source.sender?.nickname || source.senderId,
    source.senderId,
  );
}
