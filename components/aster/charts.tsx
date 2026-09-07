'use client';
import { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Holding, HoldingValuation } from '@/data';
import { aggregateValuationHistory } from '@/lib/finance';
import { money, percent } from './primitives';
export const palette = [
  '#8064e5',
  '#39b9ae',
  '#6f9ee7',
  '#f1b650',
  '#a693d4',
  '#a7b4c6',
];
export const classColors: Record<string, string> = {
  'Public equities': palette[0],
  'Private equity': palette[1],
  'Venture capital': palette[4],
  'Real estate': palette[2],
  'Fixed income': palette[3],
  Cash: palette[5],
};
export type ChartPoint = {
  date: string;
  value: number;
  flow: number;
  index: number | null;
};
export function makeHistory(
  rows: HoldingValuation[],
  ids: Set<string>,
  start: string,
): ChartPoint[] {
  const points = aggregateValuationHistory(rows, [...ids], 'daily').filter(
    (p) => p.date >= start,
  );
  const base = points[0]?.twrIndex;
  return points.map((p) => ({
    date: p.date,
    value: p.valueEUR,
    flow: p.netExternalFlowEUR,
    index: base && p.twrIndex !== null ? (p.twrIndex / base) * 100 : null,
  }));
}
function ChartTip({
  active,
  payload,
  label,
  performance = false,
}: {
  active?: boolean;
  payload?: { value: number; name: string; color?: string }[];
  label?: string;
  performance?: boolean;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <span>
        {label
          ? new Date(label + 'T12:00:00Z').toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })
          : ''}
      </span>
      {payload.map((p, i) => (
        <strong key={i}>
          {performance ? (p.value - 100).toFixed(2) + '%' : money(p.value, 2)}
        </strong>
      ))}
    </div>
  );
}
export function ValueChart({
  data,
  performance = false,
  small = false,
}: {
  data: ChartPoint[];
  performance?: boolean;
  small?: boolean;
}) {
  const points = useMemo(
    () =>
      data.filter(
        (_, i) =>
          i % Math.max(1, Math.floor(data.length / 100)) === 0 ||
          i === data.length - 1,
      ),
    [data],
  );
  const shortPeriod =
    points.length > 1 &&
    Date.parse(points.at(-1)!.date) - Date.parse(points[0].date) <
      40 * 86400000;
  const seen = new Set<string>();
  const ticks = shortPeriod
    ? undefined
    : points
        .filter((p, i) => {
          const month = p.date.slice(0, 7);
          if (seen.has(month)) return false;
          seen.add(month);
          return i !== 0 || Number(p.date.slice(8)) < 26;
        })
        .map((p) => p.date);
  const values = points
    .map((p) => (performance ? p.index : p.value))
    .filter((v): v is number => v !== null);
  const span = values.length ? Math.max(...values) - Math.min(...values) : 0;
  return (
    <figure
      className={small ? 'value-chart small' : 'value-chart'}
      aria-label={
        performance
          ? 'Synthetic time-weighted return over the selected period'
          : 'Synthetic portfolio value over the selected period'
      }
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{ width: 500, height: 230 }}
      >
        <AreaChart
          data={points}
          margin={{ top: 16, right: 10, left: 0, bottom: 0 }}
        >
          <defs>
            <linearGradient
              id={performance ? 'returnFill' : 'valueFill'}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor="#8064e5" stopOpacity={0.19} />
              <stop offset="95%" stopColor="#8064e5" stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <CartesianGrid
            stroke="#ecebf0"
            strokeDasharray="3 4"
            vertical={false}
          />
          <XAxis
            dataKey="date"
            ticks={ticks}
            axisLine={false}
            tickLine={false}
            minTickGap={42}
            tick={{ fill: '#82828c', fontSize: 12 }}
            tickMargin={13}
            tickFormatter={(v) =>
              new Date(v + 'T12:00:00Z').toLocaleDateString(
                'en-GB',
                shortPeriod
                  ? { day: 'numeric', month: 'short' }
                  : { month: 'short' },
              )
            }
          />
          <YAxis
            domain={
              performance
                ? ['auto', 'auto']
                : [
                    (min: number) => Math.max(0, min * 0.96),
                    (max: number) => max * 1.025,
                  ]
            }
            width={59}
            axisLine={false}
            tickLine={false}
            tick={{ fill: '#82828c', fontSize: 12 }}
            tickFormatter={(v) =>
              performance
                ? (Math.abs(v - 100) < 0.00001 ? 0 : v - 100).toFixed(
                    span < 2 ? 1 : 0,
                  ) + '%'
                : money(v, span < 5000000 ? 1 : 0)
            }
          />
          <Tooltip
            content={<ChartTip performance={performance} />}
            cursor={{ stroke: '#ab99ec', strokeDasharray: '4 4' }}
          />
          <Area
            type="monotone"
            dataKey={performance ? 'index' : 'value'}
            stroke="#8064e5"
            strokeWidth={2.3}
            fill={'url(#' + (performance ? 'returnFill' : 'valueFill') + ')'}
            activeDot={{
              r: 5,
              fill: '#8064e5',
              stroke: 'white',
              strokeWidth: 3,
            }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </figure>
  );
}
export function AllocationChart({
  holdings,
  dimension = 'assetClass',
  onSelect,
}: {
  holdings: Holding[];
  dimension?: 'assetClass' | 'geography' | 'currency';
  onSelect?: (v: string) => void;
}) {
  const [hover, setHover] = useState<string | null>(null),
    [pinned, setPinned] = useState<string | null>(null);
  const slices = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of holdings)
      m.set(h[dimension], (m.get(h[dimension]) || 0) + h.valueEUR);
    return [...m]
      .map(([name, value], i) => ({
        name,
        value,
        color:
          dimension === 'assetClass'
            ? classColors[name]
            : palette[i % palette.length],
      }))
      .sort((a, b) => b.value - a.value);
  }, [holdings, dimension]);
  const total = slices.reduce((s, x) => s + x.value, 0),
    selected = slices.find((x) => x.name === (hover ?? pinned));
  return (
    <div className="allocation-layout">
      <figure
        className="donut-wrap"
        aria-label={'Portfolio allocation by ' + dimension}
      >
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 500, height: 230 }}
        >
          <PieChart>
            <Pie
              data={slices.map((s) => ({
                ...s,
                fill: s.color,
                opacity: hover && hover !== s.name ? 0.8 : 1,
              }))}
              dataKey="value"
              nameKey="name"
              innerRadius="64%"
              outerRadius="92%"
              paddingAngle={1.6}
              startAngle={90}
              endAngle={-270}
              stroke="none"
              onMouseEnter={(_, i) => setHover(slices[i].name)}
              onMouseLeave={() => setHover(null)}
              onClick={(_, i) => {
                setPinned(pinned === slices[i].name ? null : slices[i].name);
                onSelect?.(slices[i].name);
              }}
              isAnimationActive={false}
            ></Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="donut-center">
          <strong>{money(selected?.value ?? total)}</strong>
          <span>{selected ? selected.name : 'Total value'}</span>
        </div>
      </figure>
      <div className="allocation-legend">
        {slices.map((s) => (
          <button
            key={s.name}
            aria-pressed={pinned === s.name}
            onClick={() => {
              setPinned(pinned === s.name ? null : s.name);
              onSelect?.(s.name);
            }}
            onMouseEnter={() => setHover(s.name)}
            onMouseLeave={() => setHover(null)}
          >
            <i style={{ background: s.color }} />
            <span>{s.name}</span>
            <strong>{percent(s.value / total)}</strong>
          </button>
        ))}
      </div>
    </div>
  );
}
export function AllocationBars({
  data,
  horizontal = false,
}: {
  data: { name: string; value: number; color?: string }[];
  horizontal?: boolean;
}) {
  return (
    <figure className="bar-chart" aria-label="Allocation comparison chart">
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{ width: 500, height: 230 }}
      >
        <BarChart
          data={data.map((d, i) => ({
            ...d,
            fill: d.color ?? palette[i % palette.length],
          }))}
          layout={horizontal ? 'vertical' : 'horizontal'}
          margin={{ top: 5, right: 16, bottom: 5, left: horizontal ? 24 : 0 }}
        >
          <CartesianGrid
            stroke="#ecebf0"
            strokeDasharray="3 4"
            vertical={false}
          />
          <XAxis
            type={horizontal ? 'number' : 'category'}
            dataKey={horizontal ? undefined : 'name'}
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 12, fill: '#82828c' }}
            tickFormatter={horizontal ? (v) => money(v, 0) : undefined}
          />
          <YAxis
            type={horizontal ? 'category' : 'number'}
            dataKey={horizontal ? 'name' : undefined}
            width={horizontal ? 90 : 62}
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 12, fill: '#82828c' }}
            tickFormatter={horizontal ? undefined : (v) => money(v, 0)}
          />
          <Tooltip
            formatter={(v) => money(Number(v), 2)}
            contentStyle={{
              border: '1px solid #e8e8ed',
              borderRadius: 8,
              fontSize: 13,
            }}
            cursor={{ fill: '#f7f6fb' }}
          />
          <Bar
            dataKey="value"
            radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
            barSize={horizontal ? 22 : 36}
            isAnimationActive={false}
          ></Bar>
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}
