import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import Taro from '@tarojs/taro';
import {
  isLeaderOverdue, ownerAt, recomputeObservation, sampleNeedsReverify, uid,
  type LogEntry, type Observation, type OutboxBundle, type OwnershipInterval,
  type Risk, type Sample, type Segment, type SegmentId, type Team, type TeamId, type TrackPoint
} from '../domain/patrol';

const STORAGE_KEY = 'yf57-patrol-v2';
const MIN = 60 * 1000;

interface PatrolState {
  now: number;
  online: boolean;
  teams: Team[];
  segments: Segment[];
  intervals: OwnershipInterval[];
  points: TrackPoint[];
  observations: Observation[];
  samples: Sample[];
  outbox: OutboxBundle[];
  sentBundles: OutboxBundle[];
  logs: LogEntry[];
}

function buildSeed(): PatrolState {
  const now = Date.now();
  const heldSince = now - 60 * MIN;
  const teams: Team[] = [
    { id: 'alpha', name: '甲队（溪谷组）', leaderName: '老周', leaderLastSeen: now - 10 * MIN },
    { id: 'beta', name: '乙队（山脊组）', leaderName: '阿林', leaderLastSeen: now - 20 * MIN }
  ];
  const segments: Segment[] = [
    { id: 'S1', name: 'S1 溪谷样线段', color: '#166534', heldSince, heldUntil: null, ownerTeamId: 'alpha' },
    { id: 'S2', name: 'S2 山脊样线段', color: '#1d4ed8', heldSince: null, heldUntil: null, ownerTeamId: null }
  ];
  const intervals: OwnershipInterval[] = [
    { segmentId: 'S1', teamId: 'alpha', from: heldSince, to: null, note: '排班开始，甲队持有' }
  ];
  const points: TrackPoint[] = [
    { id: uid('p'), dedupeKey: 'seed:p1', segmentId: 'S1', teamId: 'alpha', latitude: 30.5821, longitude: 103.2174, at: now - 50 * MIN, receivedAt: now - 48 * MIN, source: 'gps', grantTeamId: 'alpha', historyOnly: false },
    { id: uid('p'), dedupeKey: 'seed:p2', segmentId: 'S1', teamId: 'alpha', latitude: 30.5856, longitude: 103.2211, at: now - 15 * MIN, receivedAt: now - 14 * MIN, source: 'gps', grantTeamId: 'alpha', historyOnly: false }
  ];
  const seedObs: Array<Omit<Observation, 'ownerTeamId' | 'attachedPointId'>> = [
    { id: uid('o'), dedupeKey: 'seed:o1', segmentId: 'S1', teamId: 'alpha', time: now - 50 * MIN, note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', reviewed: false, sync: 'synced', receivedAt: now - 48 * MIN, historyOnly: false },
    { id: uid('o'), dedupeKey: 'seed:o2', segmentId: 'S1', teamId: 'alpha', time: now - 15 * MIN, note: '红外相机外壳松动，已拍照待补报', risk: 'high', reviewed: false, sync: 'synced', receivedAt: now - 14 * MIN, historyOnly: false }
  ];
  const observations: Observation[] = seedObs.map((o) => ({ ...o, ...recomputeObservation(o, points, intervals) }));
  const samples: Sample[] = [
    { id: uid('s'), dedupeKey: 'seed:s1', segmentId: 'S1', teamId: 'alpha', ownerTeamId: 'alpha', code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'submitted', receivedAt: now - 40 * MIN, historyOnly: false, verification: null }
  ];
  return {
    now, online: false, teams, segments, intervals, points, observations, samples,
    outbox: [], sentBundles: [],
    logs: [{ id: uid('log'), at: now, kind: 'info', text: '初始：甲队持有 S1 溪谷段，S2 山脊段待接；当前为断网离线状态。' }]
  };
}

function readState(): PatrolState {
  try {
    const saved = Taro.getStorageSync(STORAGE_KEY);
    return saved ? (JSON.parse(saved) as PatrolState) : buildSeed();
  } catch {
    return buildSeed();
  }
}

function pushLog(state: PatrolState, kind: LogEntry['kind'], text: string) {
  state.logs.unshift({ id: uid('log'), at: state.now, kind, text });
  if (state.logs.length > 60) state.logs.length = 60;
}

/** 轨迹点更新后，重算全部观察归属；归属发生变化的逐条入日志 */
function recomputeAllObservations(state: PatrolState) {
  for (const obs of state.observations) {
    const next = recomputeObservation(obs, state.points, state.intervals);
    if (obs.ownerTeamId !== next.ownerTeamId || obs.attachedPointId !== next.attachedPointId) {
      const before = obs.ownerTeamId ? teamName(state, obs.ownerTeamId) : '未知';
      const after = next.ownerTeamId ? teamName(state, next.ownerTeamId) : '未知';
      if (obs.receivedAt !== null || obs.ownerTeamId !== null) {
        pushLog(state, 'recompute', `观察「${obs.note.slice(0, 12)}」归属重算：${before} → ${after}（轨迹点更新）`);
      }
      obs.ownerTeamId = next.ownerTeamId;
      obs.attachedPointId = next.attachedPointId;
    }
  }
}

/** 刷新全部样本的责任方；责任方一变，已有核验立即标记失效（重算） */
function refreshSampleOwners(state: PatrolState, segmentId?: SegmentId) {
  for (const sample of state.samples) {
    if (segmentId && sample.segmentId !== segmentId) continue;
    sample.ownerTeamId = ownerAt(state.intervals, sample.segmentId, state.now);
    if (sample.verification && sampleNeedsReverify(sample, state.intervals, state.now)) {
      sample.verification.stale = true;
      pushLog(state, 'recompute', `样本 ${sample.code} 责任方变更，核验结论失效，需由新责任方重算。`);
    }
  }
}

function teamName(state: PatrolState, id: TeamId): string {
  return state.teams.find((t) => t.id === id)?.name ?? id;
}

function openBundle(state: PatrolState, teamId: TeamId, segmentId: SegmentId): OutboxBundle {
  let bundle = state.outbox.find((b) => b.teamId === teamId && b.segmentId === segmentId);
  if (!bundle) {
    bundle = { id: uid('b'), teamId, segmentId, createdAt: state.now, takeOver: false, observations: [], points: [], samples: [] };
    state.outbox.push(bundle);
  }
  return bundle;
}

/** 一个离线暂存包到达站点：先到站点仲裁持有权，再幂等合并记录 */
function deliverBundle(state: PatrolState, bundleId: string) {
  const index = state.outbox.findIndex((b) => b.id === bundleId);
  if (index < 0) return;
  const bundle = state.outbox[index];
  state.outbox.splice(index, 1);
  state.sentBundles.unshift(bundle);
  if (state.sentBundles.length > 20) state.sentBundles.length = 20;

  const segment = state.segments.find((s) => s.id === bundle.segmentId)!;
  const claimAt = state.now; // 站点钟：以到达站点时刻为准
  let claimed = false;
  // 原队再传：到站时上传队已非当前责任队（且没有赢得接班），包内记录只能补历史
  let bundleHistory = false;

  if (bundle.takeOver) {
    if (segment.ownerTeamId === bundle.teamId) {
      pushLog(state, 'info', `${teamName(state, bundle.teamId)} 已是 ${segment.name} 责任队，接班声明按普通补传处理。`);
    } else {
      const current = state.intervals.find((iv) => iv.segmentId === segment.id && iv.to === null);
      if (current) {
        current.to = claimAt;
        pushLog(state, 'claim', `${teamName(state, bundle.teamId)} 的接班记录先到站点（${segment.name}），${teamName(state, current.teamId)} 持有截止，路段移交新责任队；交接时间与上传顺序冲突时以本次到站顺序为准。`);
      } else {
        pushLog(state, 'claim', `${segment.name} 处于待接，${teamName(state, bundle.teamId)} 的接班记录先到站点，直接持有路段。`);
      }
      state.intervals.push({ segmentId: segment.id, teamId: bundle.teamId, from: claimAt, to: null, note: '接班包先到站点，获得持有权' });
      segment.ownerTeamId = bundle.teamId;
      segment.heldSince = claimAt;
      segment.heldUntil = null;
      claimed = true;
    }
  } else {
    // 普通补传：到站时上传队已非当前责任队 → 只补历史；路段待接时普通补传不产生持有权
    bundleHistory = segment.ownerTeamId !== null && segment.ownerTeamId !== bundle.teamId;
    if (bundleHistory) {
      pushLog(state, 'history', `${teamName(state, bundle.teamId)} 的补传到站时，${segment.name} 已由 ${teamName(state, segment.ownerTeamId!)} 持有，仅作历史补录，归属不变。`);
    } else if (segment.ownerTeamId === null) {
      pushLog(state, 'info', `${segment.name} 当前待接，${teamName(state, bundle.teamId)} 的普通补传不构成接班，路段仍待接。`);
    }
  }

  const wasEmpty = bundle.observations.length === 0 && bundle.points.length === 0 && bundle.samples.length === 0;

  // 轨迹点：按幂等键去重，重复补传只入账一次
  let dupPoints = 0;
  for (const p of bundle.points) {
    if (state.points.some((existing) => existing.dedupeKey === p.dedupeKey)) { dupPoints += 1; continue; }
    // 接班包赢得持有权：包内轨迹点授予接班队；否则按轨迹点时刻的路段责任方（待接为 null）
    const grantTeamId = claimed ? bundle.teamId : ownerAt(state.intervals, bundle.segmentId, p.at);
    state.points.push({ id: uid('p'), ...p, segmentId: bundle.segmentId, teamId: bundle.teamId, receivedAt: claimAt, grantTeamId, historyOnly: claimed ? false : bundleHistory });
  }
  if (dupPoints > 0) pushLog(state, 'dupe', `${teamName(state, bundle.teamId)} 补传 ${dupPoints} 个重复轨迹点，幂等忽略，只入账一次。`);

  // 观察：去重后入账；归属一律由"轨迹点 + 路段责任归属"重算（接班包的点已授予接班队）
  let dupObs = 0;
  let historyObs = 0;
  for (const raw of bundle.observations) {
    if (state.observations.some((existing) => existing.dedupeKey === raw.dedupeKey)) { dupObs += 1; continue; }
    const draft: Observation = {
      id: uid('o'), ...raw, segmentId: bundle.segmentId, teamId: bundle.teamId,
      ownerTeamId: null, attachedPointId: null, sync: 'synced', receivedAt: claimAt, historyOnly: false, reviewed: false
    };
    const next = recomputeObservation(draft, state.points, state.intervals);
    draft.ownerTeamId = next.ownerTeamId;
    draft.attachedPointId = next.attachedPointId;
    // 是否补历史取决于到站时上传队是否还是责任队（与记录时刻的历史归属无关）
    draft.historyOnly = claimed ? false : bundleHistory;
    if (draft.historyOnly) historyObs += 1;
    state.observations.unshift(draft);
  }
  if (dupObs > 0) pushLog(state, 'dupe', `${dupObs} 条重复观察补传被幂等忽略。`);
  if (historyObs > 0) pushLog(state, 'history', `${teamName(state, bundle.teamId)} 已非 ${segment.name} 责任队，${historyObs} 条观察只补历史，路段归属不变。`);

  // 样本：去重，责任方取当前路段归属；非责任队上传只补历史
  let dupSamples = 0;
  let historySamples = 0;
  for (const raw of bundle.samples) {
    if (state.samples.some((existing) => existing.dedupeKey === raw.dedupeKey)) { dupSamples += 1; continue; }
    const owner = claimed ? bundle.teamId : ownerAt(state.intervals, bundle.segmentId, claimAt);
    if (bundleHistory) historySamples += 1;
    state.samples.unshift({
      id: uid('s'), ...raw, segmentId: bundle.segmentId, teamId: bundle.teamId,
      ownerTeamId: owner, status: 'submitted', receivedAt: claimAt, historyOnly: claimed ? false : bundleHistory, verification: null
    });
  }
  if (dupSamples > 0) pushLog(state, 'dupe', `${dupSamples} 个重复样本补传被幂等忽略。`);
  if (historySamples > 0) pushLog(state, 'history', `${historySamples} 个样本由原责任队补传，仅作历史，核验按当前责任方重算。`);

  if (!wasEmpty) pushLog(state, 'merge', `${teamName(state, bundle.teamId)} 的离线记录到达站点并合并${bundle.takeOver ? '（接班包）' : ''}：轨迹 ${bundle.points.length - dupPoints}、观察 ${bundle.observations.length - dupObs}、样本 ${bundle.samples.length - dupSamples}。`);

  recomputeAllObservations(state);
  refreshSampleOwners(state, segment.id);
}

const slice = createSlice({
  name: 'patrol',
  initialState: readState(),
  reducers: {
    toggleOnline: (state) => {
      state.online = !state.online;
      pushLog(state, 'info', state.online ? '网络恢复：离线包可以上传到站。' : '网络断开：记录继续写入离线暂存。');
    },
    tick: (state, action: PayloadAction<number>) => {
      state.now += action.payload * MIN;
      // 队长失联超期：路段回到待接
      for (const segment of state.segments) {
        if (!segment.ownerTeamId) continue;
        const team = state.teams.find((t) => t.id === segment.ownerTeamId)!;
        if (isLeaderOverdue(team, state.now)) {
          const current = state.intervals.find((iv) => iv.segmentId === segment.id && iv.to === null);
          if (current) current.to = state.now;
          segment.ownerTeamId = null;
          segment.heldUntil = state.now;
          pushLog(state, 'timeout', `${team.name}队长 ${team.leaderName} 失联超期（>30 分钟无心跳），${segment.name} 回到待接状态，等待接班。`);
          refreshSampleOwners(state, segment.id);
        }
      }
    },
    heartbeat: (state, action: PayloadAction<TeamId>) => {
      const team = state.teams.find((t) => t.id === action.payload)!;
      team.leaderLastSeen = state.now;
      pushLog(state, 'info', `${team.name}队长 ${team.leaderName} 上报心跳，失联计时重置。`);
    },
    stageObservation: (state, action: PayloadAction<{ teamId: TeamId; segmentId: SegmentId; note: string; risk: Risk }>) => {
      const bundle = openBundle(state, action.payload.teamId, action.payload.segmentId);
      bundle.observations.push({ dedupeKey: uid('k'), time: state.now, note: action.payload.note, risk: action.payload.risk });
      pushLog(state, 'info', `离线记录观察 1 条，已存入 ${teamName(state, bundle.teamId)} / ${action.payload.segmentId} 暂存包。`);
    },
    stagePoint: (state, action: PayloadAction<{ teamId: TeamId; segmentId: SegmentId; latitude: number; longitude: number }>) => {
      const bundle = openBundle(state, action.payload.teamId, action.payload.segmentId);
      bundle.points.push({ dedupeKey: uid('k'), latitude: action.payload.latitude, longitude: action.payload.longitude, at: state.now, source: 'gps' });
      pushLog(state, 'info', `轨迹点离线入账 1 个，等待联网补传。`);
    },
    stageSample: (state, action: PayloadAction<{ teamId: TeamId; segmentId: SegmentId; code: string; species: string; count: number }>) => {
      const bundle = openBundle(state, action.payload.teamId, action.payload.segmentId);
      bundle.samples.push({ dedupeKey: uid('k'), code: action.payload.code, species: action.payload.species, count: action.payload.count });
      pushLog(state, 'info', `样本 ${action.payload.code} 离线登记，等待联网补传。`);
    },
    setTakeOver: (state, action: PayloadAction<{ bundleId: string; takeOver: boolean }>) => {
      const bundle = state.outbox.find((b) => b.id === action.payload.bundleId);
      if (bundle) {
        bundle.takeOver = action.payload.takeOver;
        pushLog(state, 'info', action.payload.takeOver ? `${teamName(state, bundle.teamId)} 的暂存包标记为接班声明，到站将按先到站点仲裁。` : '已取消接班标记。');
      }
    },
    discardBundle: (state, action: PayloadAction<string>) => {
      const i = state.outbox.findIndex((b) => b.id === action.payload);
      if (i >= 0) state.outbox.splice(i, 1);
    },
    deliverNext: (state) => {
      if (!state.online) { pushLog(state, 'info', '仍处于断网状态，离线包到不了站点。'); return; }
      const bundle = [...state.outbox].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (bundle) {
        pushLog(state, 'merge', `网络恢复，${teamName(state, bundle.teamId)} 的暂存包上传到站（按到达站点顺序处理）。`);
        deliverBundle(state, bundle.id);
      }
    },
    deliverBundleById: (state, action: PayloadAction<string>) => {
      if (!state.online) { pushLog(state, 'info', '仍处于断网状态，离线包到不了站点。'); return; }
      const bundle = state.outbox.find((b) => b.id === action.payload);
      if (bundle) {
        pushLog(state, 'merge', `${teamName(state, bundle.teamId)} / ${bundle.segmentId} 的暂存包到达站点（先到先得，无论交接时间早晚）。`);
        deliverBundle(state, bundle.id);
      }
    },
    deliverAll: (state) => {
      if (!state.online) { pushLog(state, 'info', '仍处于断网状态，离线包到不了站点。'); return; }
      if (state.outbox.length === 0) return;
      pushLog(state, 'merge', `网络恢复，合并 ${state.outbox.length} 个离线包，按到达站点顺序逐个仲裁。`);
      while (state.outbox.length > 0) {
        const bundle = [...state.outbox].sort((a, b) => a.createdAt - b.createdAt)[0];
        deliverBundle(state, bundle.id);
      }
    },
    retransmit: (state, action: PayloadAction<string>) => {
      // 重复补传演示：用完全相同的幂等键重新入队
      const original = state.sentBundles.find((b) => b.id === action.payload);
      if (!original) return;
      const clone: OutboxBundle = {
        ...original,
        id: uid('b'),
        createdAt: state.now,
        observations: original.observations.map((o) => ({ ...o })),
        points: original.points.map((p) => ({ ...p })),
        samples: original.samples.map((s) => ({ ...s }))
      };
      state.outbox.push(clone);
      pushLog(state, 'info', `${teamName(state, clone.teamId)} 对 ${clone.segmentId} 的已传包发起重复补传（相同幂等键）。`);
    },
    reviewObservation: (state, action: PayloadAction<string>) => {
      const item = state.observations.find((o) => o.id === action.payload);
      if (item) item.reviewed = true;
    },
    reverifySample: (state, action: PayloadAction<string>) => {
      const sample = state.samples.find((s) => s.id === action.payload);
      if (!sample) return;
      const owner = ownerAt(state.intervals, sample.segmentId, state.now);
      if (!owner) { pushLog(state, 'info', `样本 ${sample.code} 所在路段待接，暂无责任方，无法核验。`); return; }
      sample.status = 'verified';
      sample.verification = { teamId: owner, at: state.now, stale: false };
      pushLog(state, 'recompute', `样本 ${sample.code} 由 ${teamName(state, owner)} 重新核验通过，结论已重算。`);
    },
    resetDemo: () => buildSeed()
  }
});

export const {
  toggleOnline, tick, heartbeat, stageObservation, stagePoint, stageSample,
  setTakeOver, discardBundle, deliverNext, deliverBundleById, deliverAll, retransmit,
  reviewObservation, reverifySample, resetDemo
} = slice.actions;

export const store = configureStore({ reducer: { patrol: slice.reducer } });
if (typeof window !== 'undefined') {
  store.subscribe(() => Taro.setStorageSync(STORAGE_KEY, JSON.stringify(store.getState().patrol)));
}

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
