# pair-wise-yf-57 野外巡护离线调查应用

## 源提示词摘要
巡护队分组轮换样线，弱网时记录观察、轨迹点和样本。样线拆成巡护路段，一个路段同一时间只认一个责任队。接班队上传离线记录后持有路段，原队再传只能补历史。交接时间和上传顺序冲突时，路段归属以先到站点的记录为准。队长失联超期时路段回到待接状态，网络恢复后合并记录。责任方一变，样本核验就要重算。轨迹点一更新，观察归属也要重算，重复补传只入账一次。

## 技术栈
Taro 3 + React + TypeScript + NutUI + Redux Toolkit + React Hook Form + Zod。

## 领域规则与落点
- **路段唯一责任队**：`src/domain/patrol.ts` 的持有区间 `OwnershipInterval` 互不重叠，`ownerAt(intervals, segment, at)` 按区间查任一时刻责任队。
- **先到站点仲裁**：离线记录以"暂存包"为单位弱网攒包，到站顺序决定归属（站点钟 `receivedAt`），与交接时间早晚无关；接班包先到站即获得持有权，原队后到站只补历史（`historyOnly`），待接段普通补传不构成接班。
- **失联超期释放**：队长心跳静默超过 30 分钟（`LEADER_TIMEOUT_MIN`），其持有路段自动回到待接，持有区间封口。
- **断网恢复合并**：网络恢复后暂存包可逐包到站或一键合并，始终按到站顺序仲裁。
- **样本核验随责任方重算**：责任队变化时已有核验标记 `stale` 失效，须由新责任队重新核验。
- **观察归属随轨迹重算**：观察挂靠同队、同路段、30 分钟窗口内最近的轨迹点，归属取该点被授予的责任队；轨迹点补传后全量重算，无点时归属"待轨迹确认"。
- **幂等补传**：观察、轨迹点、样本均带 `dedupeKey`，原样重复补传被忽略并记录日志。
- 本地状态持久化在 Taro storage（键 `yf57-patrol-v2`），页面提供站点时钟快进、断网切换、心跳上报和事件日志，可完整推演以上规则。

## 启动
```bash
npm install
npm run dev
```
开发端口：62022

> 注意：Taro 3.6.40 的官方预编译 `@tarojs/binding` 不含 linux-arm64-gnu 二进制，在 ARM64 Linux 上执行 `taro` CLI 会报 `Cannot find module '@tarojs/binding-linux-arm64-gnu'`。该 binding 仅被 `taro create` 使用；构建时可通过 `NODE_OPTIONS` 注入一个仅拦截该模块的 require 桩绕过（不影响产物）。x64 / macOS 环境无此问题。
