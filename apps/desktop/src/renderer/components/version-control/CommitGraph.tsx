import { useMemo } from "react";
import type { GitCommitSummary } from "@vela/shared";
import { laneColor, layoutCommitGraph, type GraphCommitInput, type GraphLayout } from "./graph-layout";

export const commitRowHeight = 58;
const laneWidth = 16;
const graphPadding = 18;
const minGraphWidth = 78;

export interface CommitGraphGeometry {
  layout: GraphLayout;
  width: number;
  height: number;
}

/** 计算图表几何;列表用它决定每行左侧留白。 */
export function useCommitGraphGeometry(commits: GitCommitSummary[]): CommitGraphGeometry {
  return useMemo(() => {
    const input: GraphCommitInput[] = commits.map((commit) => ({
      sha: commit.sha,
      parents: commit.parents,
      boundary: commit.boundary,
    }));
    const layout = layoutCommitGraph(input);
    return {
      layout,
      width: Math.max(Math.max(layout.laneCount, 1) * laneWidth + graphPadding * 2, minGraphWidth),
      height: Math.max(commits.length, 1) * commitRowHeight,
    };
  }, [commits]);
}

/**
 * 提交关系图:结构化数据直接绘制,不依赖终端 ASCII 图的屏幕位置。
 * 绘制在列表下方,行内容由 HistoryPage 渲染。
 */
export function CommitGraph({
  commits,
  geometry,
  selectedSha,
}: {
  commits: GitCommitSummary[];
  geometry: CommitGraphGeometry;
  selectedSha: string | null;
}) {
  const { layout, width, height } = geometry;
  const rowBySha = useMemo(() => {
    const map = new Map<string, number>();
    layout.rows.forEach((row, index) => map.set(row.sha, index));
    return map;
  }, [layout.rows]);
  const y = (row: number) => row * commitRowHeight + commitRowHeight / 2;
  const x = (lane: number) => graphPadding + lane * laneWidth + laneWidth / 2;

  return (
    <svg
      className="vc-graph"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      focusable="false"
    >
      {layout.laneSegments.map((segment, index) => (
        <line
          key={`seg-${index}`}
          x1={x(segment.lane)}
          y1={y(segment.fromRow)}
          x2={x(segment.lane)}
          y2={y(Math.min(segment.toRow, commits.length - 1))}
          stroke={laneColor(segment.lane)}
          strokeWidth={1.6}
          opacity={0.55}
        />
      ))}
      {layout.edges.map((edge, index) => {
        const fromRow = rowBySha.get(edge.fromSha);
        if (fromRow === undefined) return null;
        const toRow = edge.offscreen ? commits.length - 0.35 : rowBySha.get(edge.toSha);
        if (toRow === undefined) return null;
        const x1 = x(edge.fromLane);
        const y1 = y(fromRow);
        const x2 = x(edge.toLane);
        const y2 = edge.offscreen ? commits.length * commitRowHeight - 2 : y(toRow);
        const color = laneColor(Math.max(edge.fromLane, edge.toLane));
        if (x1 === x2) {
          return (
            <line
              key={`edge-${index}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={color}
              strokeWidth={1.6}
              strokeDasharray={edge.kind === "merge" ? "3 3" : undefined}
              opacity={0.7}
            />
          );
        }
        const bend = Math.max((y2 - y1) * 0.45, 8);
        return (
          <path
            key={`edge-${index}`}
            d={`M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`}
            fill="none"
            stroke={color}
            strokeWidth={1.6}
            opacity={0.7}
          />
        );
      })}
      {layout.rows.map((row, index) => {
        const commit = commits[index];
        const color = laneColor(row.lane);
        const isHead = commit?.refs.some((ref) => ref.kind === "head") ?? false;
        const selected = commit?.sha === selectedSha;
        if (row.kind === "boundary") {
          return (
            <circle
              key={`node-${row.sha}`}
              cx={x(row.lane)}
              cy={y(index)}
              r={4}
              fill="none"
              stroke={color}
              strokeWidth={1.6}
              strokeDasharray="2 2"
              opacity={0.8}
            />
          );
        }
        return (
          <g key={`node-${row.sha}`}>
            {selected ? <circle cx={x(row.lane)} cy={y(index)} r={8} fill="none" stroke={color} strokeWidth={1.5} opacity={0.5} /> : null}
            <circle
              cx={x(row.lane)}
              cy={y(index)}
              r={isHead ? 5 : 4}
              fill={isHead ? color : "var(--vc-graph-node, #fff)"}
              stroke={color}
              strokeWidth={isHead ? 1 : 1.8}
            />
          </g>
        );
      })}
    </svg>
  );
}
