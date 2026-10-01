/**
 * 提交关系图的纯布局引擎(CG-01/CG-02)。
 *
 * 输入是按拓扑顺序(`git log --topo-order`)排列的提交:子提交在前、父提交在后,
 * 同一页内不重复。输出节点所在轨道、父子连线的两端轨道、每行轨道占用与颜色,
 * 供 SVG 渲染器直接使用。纯函数,不依赖 DOM 或 React。
 *
 * ## 轨道算法(轨道预订表)
 *
 * - `lanes[j]` 保存第 j 条轨道正在等待的提交 sha;提交到达时落在等待它的最左轨道。
 * - 多条轨道同时等待同一提交时只保留最左的一条,其余轨道在这一行合并并立即释放。
 * - 无人等待的提交使用最左空闲轨道,没有空闲轨道时才向右侧新增。
 * - 放置提交后,第一父提交继承子提交的轨道;其余父提交复用等待该父提交的最左轨道,
 *   否则在子轨道右侧分配新轨道。这样长历史中的轨道会被不断复用,`laneCount` 不会持续增长。
 * - 父提交本次未加载时仍保留轨道,并把竖线延伸到图底(离屏延续);`boundary` 提交的
 *   父提交在本地缺失,只画终点为 `?sha` 的虚线边界边,不再延续。
 * - `maxLanes` 是显示宽度上限(默认 8)。达到上限后,新增分支优先复用最左空闲轨道,
 *   没有空闲轨道时折回轨道 0;图形仍可渲染,但超出的并行分支会重叠。
 *
 * ## 边的分类
 *
 * - `merge`:目标是该提交的非第一父提交(无论父子轨道是否相同)。
 * - `fork`:第一父提交,但父子落在不同轨道(分支并入或轨道合并后回填到最左轨道)。
 * - `straight`:父子轨道相同,竖线直连。
 *
 * ## laneSegments
 *
 * 每行记录哪些轨道需要画竖线(节点、正在等待的父链、连线端点),再把连续的行合并成
 * 区间。父提交未加载的延续线延伸到 `commits.length`,即图表底部。只输出至少跨一行的
 * 区间(单行节点本身不是竖线)。渲染器可以据此画连续直线,斜线部分由 `edges` 表达。
 */

export interface GraphCommitInput {
  sha: string;
  parents: string[];
  boundary?: boolean;
  /** 页尾延续:父提交本次未加载,但会按需加载(非浅克隆边界) */
  pendingParent?: boolean;
}

export interface GraphRow {
  sha: string;
  /** 0-based lane index */
  lane: number;
  /** 节点类型:普通 / 页尾延续(父未加载) / 浅克隆边界 */
  kind: "normal" | "pending" | "boundary";
}

export interface GraphEdge {
  /** 子提交 sha */
  fromSha: string;
  /** 父提交 sha;父未加载时使用 `?<sha>` 形式的占位 id */
  toSha: string;
  fromLane: number;
  toLane: number;
  /** 该边从 from 行的 lane 出发,到 to 行(或页尾延续点)结束 */
  kind: "straight" | "merge" | "fork";
  /** 目标在本次图表之外时,绘制到图表底部继续(离屏延续) */
  offscreen: boolean;
}

export interface GraphLayout {
  rows: GraphRow[];
  edges: GraphEdge[];
  laneCount: number;
  /** 每行的 lane 占用,用于绘制连续直线 */
  laneSegments: { fromRow: number; toRow: number; lane: number }[];
}

/** 轨道颜色;颜色只用于区分相邻轨道,不代表分支或作者的永久身份。 */
export const graphLaneColors: string[] = [
  "#2563eb",
  "#7c3aed",
  "#0891b2",
  "#16a34a",
  "#d97706",
  "#dc2626",
  "#db2777",
  "#4f46e5",
  "#0d9488",
  "#65a30d",
];

/** 按轨道取色;超出调色板长度时循环取色,负值同样回绕,结果稳定可缓存。 */
export function laneColor(lane: number): string {
  const size = graphLaneColors.length;
  const index = ((lane % size) + size) % size;
  return graphLaneColors[index];
}

export function layoutCommitGraph(
  commits: GraphCommitInput[],
  options?: { maxLanes?: number },
): GraphLayout {
  const requestedMax = options?.maxLanes ?? 8;
  const maxLanes = Number.isFinite(requestedMax) ? Math.max(1, Math.floor(requestedMax)) : 8;

  const rows: GraphRow[] = [];
  const edges: GraphEdge[] = [];
  const laneSegments: GraphLayout["laneSegments"] = [];

  const rowOf = new Map<string, number>();
  for (let r = 0; r < commits.length; r++) rowOf.set(commits[r].sha, r);

  /** 轨道预订表:lanes[j] 是第 j 条轨道等待的提交 sha,null 表示空闲。 */
  const lanes: (string | null)[] = [];
  /** 已放置提交的轨道,用于防御乱序输入(正常输入用不到)。 */
  const laneOfPlaced = new Map<string, number>();
  /** 指向尚未放置父提交的待定边,父提交落地时回填 toLane 与最终分类。 */
  interface PendingEdge {
    edge: GraphEdge;
    firstParent: boolean;
  }
  const pendingBySha = new Map<string, PendingEdge[]>();
  /** occupied[r][j] 表示第 r 行第 j 条轨道需要画竖线。 */
  const occupied: boolean[][] = [];
  let maxLaneUsed = -1;

  const findExpectorLane = (sha: string): number => {
    for (let j = 0; j < lanes.length; j++) {
      if (lanes[j] === sha) return j;
    }
    return -1;
  };

  const allocateLane = (minLane: number): number => {
    for (let j = Math.max(0, minLane); j < lanes.length; j++) {
      if (lanes[j] === null) return j;
    }
    if (lanes.length < maxLanes) {
      lanes.push(null);
      return lanes.length - 1;
    }
    // 达到宽度上限:优先复用最左空闲轨道,全部占用时折回轨道 0(见文件头说明)。
    for (let j = 0; j < lanes.length; j++) {
      if (lanes[j] === null) return j;
    }
    return 0;
  };

  for (let r = 0; r < commits.length; r++) {
    const commit = commits[r];
    const before = lanes.slice();

    // 1. 落到等待该提交的最左轨道;无人等待时使用最左空闲轨道。
    let lane = -1;
    for (let j = 0; j < lanes.length; j++) {
      if (lanes[j] === commit.sha) {
        lane = j;
        break;
      }
    }
    if (lane === -1) lane = allocateLane(0);

    const kind: GraphRow["kind"] =
      commit.boundary === true ? "boundary" : commit.pendingParent === true ? "pending" : "normal";
    rows.push({ sha: commit.sha, lane, kind });
    laneOfPlaced.set(commit.sha, lane);
    if (lane > maxLaneUsed) maxLaneUsed = lane;

    // 2. 多条轨道等待同一提交:只保留最左轨道,其余在本行合并释放。
    for (let j = lane + 1; j < lanes.length; j++) {
      if (lanes[j] === commit.sha) lanes[j] = null;
    }

    // 3. 回填所有指向该提交的待定边,让它们收敛到最左轨道。
    const pending = pendingBySha.get(commit.sha);
    if (pending) {
      for (const item of pending) {
        item.edge.toLane = lane;
        item.edge.kind = item.firstParent
          ? item.edge.fromLane === lane
            ? "straight"
            : "fork"
          : "merge";
      }
      pendingBySha.delete(commit.sha);
    }

    // 4. 处理父提交:预订或复用轨道,同时生成边。
    const parents = commit.parents;
    if (kind === "boundary") {
      // 边界提交的父提交在本地缺失:虚线边界边,不预订轨道,也不做离屏延续。
      for (let i = 0; i < parents.length; i++) {
        const parentSha = parents[i];
        const waiting = i === 0 ? -1 : findExpectorLane(parentSha);
        edges.push({
          fromSha: commit.sha,
          toSha: `?${parentSha}`,
          fromLane: lane,
          toLane: i === 0 || waiting === -1 ? lane : waiting,
          kind: i === 0 ? "straight" : "merge",
          offscreen: false,
        });
      }
      lanes[lane] = null;
    } else if (parents.length === 0) {
      lanes[lane] = null;
    } else {
      for (let i = 0; i < parents.length; i++) {
        const parentSha = parents[i];
        const inPage = rowOf.has(parentSha);
        const placedLane = laneOfPlaced.get(parentSha);
        let targetLane: number;

        if (placedLane !== undefined) {
          // 防御乱序输入:父提交已在图上方,直接连过去,不再预订轨道。
          targetLane = placedLane;
          if (i === 0) lanes[lane] = null;
        } else if (i === 0) {
          // 第一父提交继承当前轨道;若其他轨道也在等待它,放置时保留最左。
          lanes[lane] = parentSha;
          targetLane = lane;
        } else {
          const waiting = findExpectorLane(parentSha);
          if (waiting !== -1) {
            targetLane = waiting;
          } else {
            targetLane = allocateLane(lane + 1);
            lanes[targetLane] = parentSha;
            if (targetLane > maxLaneUsed) maxLaneUsed = targetLane;
          }
        }

        const edge: GraphEdge = {
          fromSha: commit.sha,
          toSha: inPage ? parentSha : `?${parentSha}`,
          fromLane: lane,
          toLane: targetLane,
          kind: i > 0 ? "merge" : lane === targetLane ? "straight" : "fork",
          offscreen: !inPage,
        };
        edges.push(edge);
        if (inPage && placedLane === undefined) {
          const list = pendingBySha.get(parentSha) ?? [];
          list.push({ edge, firstParent: i === 0 });
          pendingBySha.set(parentSha, list);
        }
      }
    }

    // 5. 记录本行竖线:进入本行仍在等待的轨道 + 本行节点 + 处理完后仍在等待的轨道。
    const cell = occupied[r] ?? (occupied[r] = []);
    for (let j = 0; j < before.length; j++) {
      if (before[j] !== null) cell[j] = true;
    }
    cell[lane] = true;
    for (let j = 0; j < lanes.length; j++) {
      if (lanes[j] !== null) cell[j] = true;
    }
  }

  // 页尾仍未加载的父链延伸到图底部。
  const bottom = occupied[commits.length] ?? (occupied[commits.length] = []);
  for (let j = 0; j < lanes.length; j++) {
    if (lanes[j] !== null) bottom[j] = true;
  }

  // 把连续占用的行合并成竖线区间;至少跨一行才输出。
  for (let j = 0; j <= maxLaneUsed; j++) {
    let start = -1;
    for (let r = 0; r <= commits.length; r++) {
      const on = occupied[r]?.[j] === true;
      if (on) {
        if (start === -1) start = r;
      } else if (start !== -1) {
        if (r - 1 > start) laneSegments.push({ fromRow: start, toRow: r - 1, lane: j });
        start = -1;
      }
    }
    if (start !== -1 && commits.length > start) {
      laneSegments.push({ fromRow: start, toRow: commits.length, lane: j });
    }
  }

  return {
    rows,
    edges,
    laneCount: Math.max(1, maxLaneUsed + 1),
    laneSegments,
  };
}
