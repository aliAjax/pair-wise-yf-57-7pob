// 巡护路段轮换领域核心
// 规则要点：
// 1. 一个路段同一时间只认一个责任队；归属以记录"先到站点"的时间为准，而非交接时间。
// 2. 接班队的离线记录先到站点即持有路段（从到达站点的时刻起算）；原队之后再传只能补历史。
// 3. 队长失联超期，路段回到"待接"状态；网络恢复后记录按到达站点顺序合并。
// 4. 责任方一变，样本核验就要重算（旧核验结论保留但标记失效）。
// 5. 轨迹点一更新，观察归属重算；重复补传按幂等键只入账一次。

export type TeamId = 'alpha' | 'beta';
export type SegmentId = 'S1' | 'S2';
export type Risk = 'low' | 'medium' | 'high';
export type SampleStatus = 'draft' | 'submitted' | 'verified';
export type PointSource = 'gps' | 'manual';

// 队长失联多久后路段释放回待接（分钟）
export const LEADER_TIMEOUT_MIN = 30;
// 轨迹点与观察的最大时间差，超过则观察无法挂靠到轨迹点（分钟）
export const OBSERVATION_ATTACH_WINDOW_MIN = 30;

export interface Team {
  id: TeamId;
  name: string;
  leaderName: string;
  // 队长最后一次心跳（实时上报），用于失联超期判定
  leaderLastSeen: number;
}

export interface Segment {
  id: SegmentId;
  name: string;
  color: string;
  // 站点钟：该路段当前持有关系开始/结束的时刻；null 表示待接
  heldSince: number | null;
  heldUntil: number | null;
  ownerTeamId: TeamId | null;
}

// 一段连续的持有区间（同一时间只有一个责任队，区间互不重叠）
export interface OwnershipInterval {
  segmentId: SegmentId;
  teamId: TeamId;
  from: number; // 记录到达站点的时刻（先到先得）
  to: number | null; // null 表示当前仍持有
  note: string;
}

export interface TrackPoint {
  id: string;
  dedupeKey: string; // 幂等键，重复补传只入账一次
  segmentId: SegmentId;
  teamId: TeamId;
  latitude: number;
  longitude: number;
  at: number; // 设备记录时刻
  receivedAt: number; // 到达站点时刻
  source: PointSource;
  // 到站仲裁后该点归属的责任队：赢得持有权的接班包内轨迹点即使记录时刻更早，也授予接班队；
  // null 表示该时刻路段待接 / 上传队非责任方（只补历史）
  grantTeamId: TeamId | null;
  historyOnly: boolean; // 到站时上传队已非当前责任队，该点只补历史
}

export interface Observation {
  id: string;
  dedupeKey: string;
  segmentId: SegmentId;
  teamId: TeamId; // 采集队（离线时是谁记的）
  ownerTeamId: TeamId | null; // 归属队：由"轨迹点 + 路段责任归属"重算
  attachedPointId: string | null; // 归属依据的轨迹点
  time: number;
  note: string;
  risk: Risk;
  reviewed: boolean;
  sync: 'queued' | 'synced';
  receivedAt: number | null;
  historyOnly: boolean; // true = 上传时已非责任队，仅补历史
}

export interface SampleVerification {
  teamId: TeamId;
  at: number;
  stale: boolean; // 责任方变化后置为失效，需要重算
}

export interface Sample {
  id: string;
  dedupeKey: string;
  segmentId: SegmentId;
  teamId: TeamId;
  ownerTeamId: TeamId | null; // 责任方，来自路段归属
  code: string;
  species: string;
  count: number;
  status: SampleStatus;
  receivedAt: number | null;
  historyOnly: boolean;
  verification: SampleVerification | null;
}

export interface LogEntry {
  id: string;
  at: number;
  kind: 'claim' | 'history' | 'dupe' | 'timeout' | 'merge' | 'recompute' | 'info';
  text: string;
}

// 离线暂存包：弱网时一个队在一个路段上攒的记录，联网后整包到达站点
export interface OutboxBundle {
  id: string;
  teamId: TeamId;
  segmentId: SegmentId;
  createdAt: number;
  takeOver: boolean; // 是否为接班声明
  observations: Array<Pick<Observation, 'dedupeKey' | 'time' | 'note' | 'risk'>>;
  points: Array<Pick<TrackPoint, 'dedupeKey' | 'latitude' | 'longitude' | 'at' | 'source'>>;
  samples: Array<Pick<Sample, 'dedupeKey' | 'code' | 'species' | 'count'>>;
}

/** 路段在某一时刻的责任队（区间按开始时刻倒序查找） */
export function ownerAt(intervals: OwnershipInterval[], segmentId: SegmentId, at: number): TeamId | null {
  const hit = intervals
    .filter((iv) => iv.segmentId === segmentId && iv.from <= at && (iv.to === null || at < iv.to))
    .sort((a, b) => b.from - a.from)[0];
  return hit ? hit.teamId : null;
}

/** 队长是否失联超期 */
export function isLeaderOverdue(team: Team, now: number): boolean {
  return now - team.leaderLastSeen > LEADER_TIMEOUT_MIN * 60 * 1000;
}

/**
 * 轨迹点一更新，观察归属重算：
 * 找同队、时间窗口内最近的轨迹点，观察归属 = 该轨迹点时刻路段的责任队。
 * 挂靠不到轨迹点时，归属未知（等后续轨迹补传后会再次重算）。
 */
export function recomputeObservation(
  obs: Pick<Observation, 'teamId' | 'segmentId' | 'time'>,
  points: TrackPoint[],
  intervals: OwnershipInterval[]
): { ownerTeamId: TeamId | null; attachedPointId: string | null } {
  const windowMs = OBSERVATION_ATTACH_WINDOW_MIN * 60 * 1000;
  let best: TrackPoint | null = null;
  for (const p of points) {
    if (p.teamId !== obs.teamId || p.segmentId !== obs.segmentId) continue;
    const delta = Math.abs(p.at - obs.time);
    if (delta <= windowMs && (!best || delta < Math.abs(best.at - obs.time))) best = p;
  }
  if (!best) return { ownerTeamId: null, attachedPointId: null };
  if (best.grantTeamId !== undefined && best.grantTeamId !== null) {
    return { ownerTeamId: best.grantTeamId, attachedPointId: best.id };
  }
  return { ownerTeamId: ownerAt(intervals, best.segmentId, best.at), attachedPointId: best.id };
}

/** 责任方一变，样本核验重算：核验队与当前责任队不一致即失效 */
export function sampleNeedsReverify(sample: Sample, intervals: OwnershipInterval[], at: number): boolean {
  const owner = ownerAt(intervals, sample.segmentId, at);
  return sample.status === 'verified' && (owner === null || (sample.verification !== null && sample.verification.teamId !== owner));
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
