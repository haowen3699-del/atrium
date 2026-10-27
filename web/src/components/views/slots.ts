/**
 * 稳定槽位：给每个 id 分配一个"尽量不变"的整数槽位。
 * 目的：agent 增删（会话球来去）时，已有元素不会被整体顶掉位置，
 * 轨道因此能连续转动，而不是每次快照都整体跳一下。
 */
export function assignSlots(prev: Map<string, number>, ids: string[]): Map<string, number> {
  const next = new Map<string, number>();
  const used = new Set<number>();
  const live = new Set(ids);
  for (const [id, s] of prev) {
    if (live.has(id)) {
      next.set(id, s);
      used.add(s);
    }
  }
  let cursor = 0;
  for (const id of ids) {
    if (next.has(id)) continue;
    while (used.has(cursor)) cursor++;
    next.set(id, cursor);
    used.add(cursor);
  }
  return next;
}

export function maxSlot(slots: Map<string, number>): number {
  let m = -1;
  for (const v of slots.values()) if (v > m) m = v;
  return m;
}