import { useMemo, useState } from 'react';
import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import { LEADER_TIMEOUT_MIN, type Risk, type SegmentId, type TeamId } from '../../domain/patrol';
import {
  deliverAll, deliverBundleById, deliverNext, discardBundle, heartbeat, retransmit,
  resetDemo, reverifySample, reviewObservation, setTakeOver, stageObservation,
  stagePoint, stageSample, tick, toggleOnline, type RootState
} from '../../store';
import './index.scss';

const formSchema = z.object({ note: z.string().min(2), risk: z.enum(['low', 'medium', 'high']), code: z.string(), species: z.string(), count: z.string() });
type FormValues = z.infer<typeof formSchema>;

const pad = (n: number) => String(n).padStart(2, '0');
function clock(ts: number) { const d = new Date(ts); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function clockShort(ts: number) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

const RISK_LABEL: Record<Risk, string> = { low: '低', medium: '中', high: '高' };
const LOG_COLOR: Record<string, string> = { claim: '#15803d', history: '#1d4ed8', dupe: '#b45309', timeout: '#b91c1c', merge: '#0e7490', recompute: '#7c3aed', info: '#64748b' };

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.patrol);
  const [teamId, setTeamId] = useState<TeamId>('alpha');
  const [segmentId, setSegmentId] = useState<SegmentId>('S1');
  const { register, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: { note: '', risk: 'low', code: '', species: '', count: '1' } });

  const teamName = (id: TeamId | null) => state.teams.find((x) => x.id === id)?.name ?? '待接';
  const staleSamples = state.samples.filter((s) => s.verification?.stale).length;
  const queuedItems = useMemo(() => state.outbox.reduce((sum, b) => sum + b.observations.length + b.points.length + b.samples.length, 0), [state.outbox]);

  const recordPoint = async () => {
    const jitter = state.points.length;
    try {
      const result = await Taro.getLocation({ type: 'gcj02' });
      dispatch(stagePoint({ teamId, segmentId, latitude: result.latitude, longitude: result.longitude }));
    } catch {
      dispatch(stagePoint({ teamId, segmentId, latitude: 30.58 + jitter * 0.001, longitude: 103.22 + jitter * 0.001 }));
    }
  };

  const submit = (values: FormValues) => {
    dispatch(stageObservation({ teamId, segmentId, note: values.note, risk: values.risk }));
    if (values.species) {
      dispatch(stageSample({ teamId, segmentId, code: values.code || `WD-${Date.now().toString().slice(-5)}`, species: values.species, count: Number(values.count) || 1 }));
    }
    reset();
  };

  return <View className="page">
    <View className="hero">
      <Text className="eyebrow">FIELD PATROL / 弱网离线 · 站点仲裁</Text>
      <Text className="title">{t.title}</Text>
      <Text className="sub">路段同一时间只认一个责任队，归属以先到站点的记录为准；原队后传只补历史。</Text>
      <View className="status-row">
        <Text className={`badge ${state.online ? 'online' : 'offline'}`}>{state.online ? '● 网络正常' : '○ 断网离线'}</Text>
        <Text className="badge clock">站点时钟 {clock(state.now)}</Text>
      </View>
    </View>

    <View className="metrics">
      <View><Text>轨迹点</Text><Text className="metric">{state.points.length}</Text></View>
      <View><Text>离线待传</Text><Text className="metric warn">{state.outbox.length}包/{queuedItems}条</Text></View>
      <View><Text>核验待重算</Text><Text className={`metric ${staleSamples ? 'danger' : ''}`}>{staleSamples}</Text></View>
    </View>

    <View className="card">
      <View className="card-title">站点模拟台</View>
      <View className="btn-row">
        <Button size="mini" onClick={() => dispatch(toggleOnline())}>{state.online ? '切到断网' : '网络恢复'}</Button>
        <Button size="mini" onClick={() => dispatch(tick(10))}>时钟 +10 分</Button>
        <Button size="mini" onClick={() => dispatch(tick(25))}>时钟 +25 分</Button>
        <Button size="mini" onClick={() => dispatch(resetDemo())}>重置演示</Button>
      </View>
      <Text className="hint">队长超过 {LEADER_TIMEOUT_MIN} 分钟没有心跳，其持有路段自动回到待接；网络恢复后离线记录按到站顺序合并。</Text>
      <View className="heartbeats">
        {state.teams.map((team) => {
          const quietMin = Math.max(0, Math.round((state.now - team.leaderLastSeen) / 60000));
          const overdue = quietMin > LEADER_TIMEOUT_MIN;
          return <View className="heartbeat" key={team.id}>
            <Text>{team.name} · 队长 {team.leaderName}</Text>
            <Text className={overdue ? 'danger' : 'muted'}>{overdue ? `失联 ${quietMin} 分 · 已超期` : `静默 ${quietMin}/${LEADER_TIMEOUT_MIN} 分`}</Text>
            <Button size="mini" onClick={() => dispatch(heartbeat(team.id))}>上报心跳</Button>
          </View>;
        })}
      </View>
    </View>

    <View className="card">
      <View className="card-title">巡护路段与责任队</View>
      {state.segments.map((segment) => {
        const overdue = segment.ownerTeamId && (() => {
          const team = state.teams.find((x) => x.id === segment.ownerTeamId)!;
          return state.now - team.leaderLastSeen > LEADER_TIMEOUT_MIN * 60000;
        })();
        return <View className="segment" key={segment.id}>
          <View className="segment-head">
            <Text className="segment-name" style={{ color: segment.color }}>{segment.name}</Text>
            {segment.ownerTeamId
              ? <Text className={`badge ${overdue ? 'danger-badge' : 'held-badge'}`}>{overdue ? '队长失联超期' : `持有：${teamName(segment.ownerTeamId)}`}</Text>
              : <Text className="badge pending-badge">待接</Text>}
          </View>
          <Text className="muted">
            {segment.ownerTeamId ? `自 ${clockShort(segment.heldSince!)} 起持有` : segment.heldUntil ? `${clockShort(segment.heldUntil)} 释放回待接` : '尚无队伍持有'}
          </Text>
          <View className="timeline">
            {state.intervals.filter((iv) => iv.segmentId === segment.id).sort((a, b) => a.from - b.from).map((iv, i, arr) =>
              <Text className="timeline-item" key={`${iv.from}-${i}`}>
                {clockShort(iv.from)} → {i === arr.length - 1 && iv.to === null ? '至今' : clockShort(iv.to!)}：{teamName(iv.teamId)} · {iv.note}
              </Text>
            )}
          </View>
        </View>;
      })}
    </View>

    <View className="card">
      <View className="card-title">现场离线记录</View>
      <View className="tab-row">
        {state.teams.map((team) => <Button key={team.id} size="mini" className={teamId === team.id ? 'tab active' : 'tab'} onClick={() => setTeamId(team.id)}>{team.name}</Button>)}
      </View>
      <View className="tab-row">
        {state.segments.map((segment) => <Button key={segment.id} size="mini" className={segmentId === segment.id ? 'tab active' : 'tab'} onClick={() => setSegmentId(segment.id)}>{segment.name}</Button>)}
      </View>
      <form onSubmit={handleSubmit(submit)}>
        <Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险（弱网先存本机）" {...register('note', { required: true })} />
        <View className="two">
          <Input className="input" placeholder="样本编号（可空）" {...register('code')} />
          <Input className="input" placeholder="物种/样本名称" {...register('species')} />
        </View>
        <View className="two">
          <Input className="input" type="number" placeholder="数量" {...register('count')} />
          <select className="input select" {...register('risk')}><option value="low">风险：低</option><option value="medium">风险：中</option><option value="high">风险：高</option></select>
        </View>
        <Button className="primary" formType="submit">{t.save}（离线暂存）</Button>
        <Button className="secondary" onClick={recordPoint}>记录当前轨迹点</Button>
      </form>
      <Text className="hint">记录与轨迹点进入当前队的路段暂存包；联网到站后，轨迹点更新会触发观察归属重算，相同内容重复补传只入账一次。</Text>
    </View>

    <View className="card">
      <View className="card-title">离线暂存 / 到站队列<Text className="count">{state.outbox.length} 个包</Text></View>
      <View className="btn-row">
        <Button size="mini" disabled={!state.online || state.outbox.length === 0} onClick={() => dispatch(deliverNext())}>{state.online ? '最早一包到站' : '断网，无法到站'}</Button>
        <Button size="mini" disabled={!state.online || state.outbox.length === 0} onClick={() => dispatch(deliverAll())}>{state.online ? '网络恢复，全部合并' : '断网中'}</Button>
      </View>
      {state.outbox.length === 0 && <Text className="muted">暂无离线包。</Text>}
      {state.outbox.map((bundle) => <View className="bundle" key={bundle.id}>
        <View className="segment-head">
          <Text className="bundle-title">{teamName(bundle.teamId)} · {bundle.segmentId} · {clockShort(bundle.createdAt)} 攒包</Text>
          {bundle.takeOver && <Text className="badge claim-badge">接班声明</Text>}
        </View>
        <Text className="muted">观察 {bundle.observations.length} · 轨迹 {bundle.points.length} · 样本 {bundle.samples.length}</Text>
        <View className="btn-row wrap">
          <Button size="mini" onClick={() => dispatch(setTakeOver({ bundleId: bundle.id, takeOver: !bundle.takeOver }))}>{bundle.takeOver ? '取消接班' : '标记为接班'}</Button>
          <Button size="mini" disabled={!state.online} onClick={() => dispatch(deliverBundleById(bundle.id))}>这包先到站</Button>
          <Button size="mini" onClick={() => dispatch(discardBundle(bundle.id))}>丢弃</Button>
        </View>
      </View>)}
      {state.sentBundles.length > 0 && <View className="sent">
        <Text className="muted">已到站的包（可发起重复补传验证幂等）：</Text>
        {state.sentBundles.slice(0, 5).map((bundle) =>
          <View className="btn-row sent-row" key={bundle.id}>
            <Text className="muted">{teamName(bundle.teamId)} · {bundle.segmentId}{bundle.takeOver ? ' · 接班包' : ''}</Text>
            <Button size="mini" onClick={() => { dispatch(retransmit(bundle.id)); }}>原样重复补传</Button>
          </View>
        )}
      </View>}
    </View>

    <View className="card">
      <View className="card-title">观察记录（归属随轨迹重算）</View>
      <ScrollView scrollY className="list">
        {state.observations.map((item) => <View className="observation" key={item.id}>
          <View className="obs-body">
            <Text className="obs-title">{item.risk === 'high' ? '高风险 · ' : ''}{item.note}</Text>
            <Text className="muted">
              {clock(item.time)} · 采集 {teamName(item.teamId)} · 归属
              <Text className={item.ownerTeamId ? 'owner-tag' : 'unknown-tag'}>{item.ownerTeamId ? teamName(item.ownerTeamId) : '待轨迹确认'}</Text>
              {item.historyOnly && <Text className="badge history-badge">补历史</Text>}
              {item.sync === 'queued' && <Text className="badge queued-badge">本机未传</Text>}
            </Text>
          </View>
          <Button size="mini" disabled={item.reviewed || item.risk === 'low'} onClick={() => dispatch(reviewObservation(item.id))}>{item.reviewed ? '已复核' : '复核'}</Button>
        </View>)}
      </ScrollView>
    </View>

    <View className="card">
      <View className="card-title">样本核验（责任方一变就重算）</View>
      {state.samples.map((sample) => <View className="sample" key={sample.id}>
        <View className="obs-body">
          <Text className="obs-title">{sample.code} · {sample.species} × {sample.count}</Text>
          <Text className="muted">
            责任方：{sample.ownerTeamId ? teamName(sample.ownerTeamId) : '路段待接'}
            {sample.historyOnly && <Text className="badge history-badge">原队补历史</Text>}
            {sample.status === 'verified' && <Text className={`badge ${sample.verification?.stale ? 'stale-badge' : 'verified-badge'}`}>
              {sample.verification?.stale ? '核验失效·待重算' : `已核验（${teamName(sample.verification!.teamId)}）`}
            </Text>}
            {sample.status === 'submitted' && <Text className="badge submitted-badge">待核验</Text>}
          </Text>
        </View>
        <Button size="mini" disabled={!sample.ownerTeamId || (sample.status === 'verified' && !sample.verification?.stale)} onClick={() => dispatch(reverifySample(sample.id))}>
          {sample.verification?.stale ? '重新核验' : '核验'}
        </Button>
      </View>)}
    </View>

    <View className="card">
      <View className="card-title">最近轨迹点</View>
      {state.points.slice(-4).reverse().map((point) => <View className="point-row" key={point.id}>
        <Text className="muted">{point.segmentId} · {point.latitude.toFixed(4)}, {point.longitude.toFixed(4)} · {clockShort(point.at)} 记录</Text>
        <Text className={`badge ${point.grantTeamId ? 'held-badge' : 'pending-badge'}`}>{point.grantTeamId ? `归属 ${teamName(point.grantTeamId)}` : '待接时记录'}</Text>
      </View>)}
    </View>

    <View className="card">
      <View className="card-title">站点事件 / 仲裁日志</View>
      <ScrollView scrollY className="list log-list">
        {state.logs.map((log) => <View className="log-item" key={log.id}>
          <Text className="log-dot" style={{ background: LOG_COLOR[log.kind] }} />
          <Text className="log-time">{clockShort(log.at)}</Text>
          <Text className="log-text" style={{ color: LOG_COLOR[log.kind] }}>{log.text}</Text>
        </View>)}
      </ScrollView>
    </View>
  </View>;
}
