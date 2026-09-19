"use client";

import { useId } from "react";

// Lightweight, dependency-free SVG charts themed off the design tokens in
// globals.css. Kept intentionally simple (no library) since these are small
// internal dashboards, not a general charting surface.

export const SERIES_COLORS = [
  "var(--accent)",
  "var(--status-info)",
  "var(--status-warning)",
  "var(--status-danger)",
  "#8e8e93",
  "#af52de",
];

export function TrendLineChart({
  values,
  labels,
  height = 140,
  showAverage = false,
  compareValues,
  compareColor = "#8e8e93",
}: {
  values: number[];
  labels?: string[];
  height?: number;
  // Dashed average line with a value callout (§Next Updates dashboard
  // mockup: "29.9k" dashed line across the trend chart).
  showAverage?: boolean;
  // Second overlay line (§Next Updates: enlarged Sale widget compares this
  // period against the previous one) — plotted on the same y-scale as
  // `values` so the two are visually comparable.
  compareValues?: number[];
  compareColor?: string;
}) {
  const width = 600;
  const pad = 8;
  const allValues = compareValues ? [...values, ...compareValues] : values;
  const max = Math.max(1, ...allValues);
  const min = Math.min(0, ...allValues);
  const range = max - min || 1;
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;

  const toPoints = (vals: number[]) =>
    vals.map((v, i) => {
      const x = pad + i * step;
      const y = pad + (height - pad * 2) * (1 - (v - min) / range);
      return [x, y] as const;
    });

  const points = toPoints(values);
  const comparePoints = compareValues ? toPoints(compareValues) : [];

  const avg = values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
  const avgY = pad + (height - pad * 2) * (1 - (avg - min) / range);

  const toPath = (pts: readonly (readonly [number, number])[]) =>
    pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const linePath = toPath(points);
  const comparePath = toPath(comparePoints);
  const areaPath =
    points.length > 0
      ? `${linePath} L${points[points.length - 1][0].toFixed(1)},${height - pad} L${points[0][0].toFixed(1)},${height - pad} Z`
      : "";

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.25" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {areaPath && <path d={areaPath} fill="url(#trendFill)" className="chart-fade-in" />}
      {comparePath && (
        <path
          d={comparePath}
          fill="none"
          stroke={compareColor}
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          pathLength={1}
          className="chart-line-draw"
        />
      )}
      {linePath && (
        <path
          d={linePath}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          pathLength={1}
          className="chart-line-draw"
        />
      )}
      {points.length > 0 && (
        <circle
          cx={points[points.length - 1][0]}
          cy={points[points.length - 1][1]}
          r={4}
          fill="var(--accent)"
          className="chart-fade-in"
        />
      )}
      {showAverage && values.length > 0 && (
        <g className="chart-fade-in">
          <line
            x1={pad}
            y1={avgY}
            x2={width - pad}
            y2={avgY}
            stroke="var(--text-secondary)"
            strokeWidth={1.5}
            strokeDasharray="5 5"
            opacity={0.6}
          />
          <text
            x={pad}
            y={avgY - 6}
            fontSize={13}
            fontWeight={700}
            fill="var(--accent)"
          >
            {formatCompact(avg)}
          </text>
        </g>
      )}
    </svg>
  );
}

// "29.9k"-style compact number, matching the mockup's dashed average-line
// callout — not a currency amount (formatAed already covers that case).
function formatCompact(n: number): string {
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export interface BarStack {
  label: string;
  segments: { value: number; color?: string }[];
}

export function MonthlyBarChart({ bars, height = 140 }: { bars: BarStack[]; height?: number }) {
  if (bars.length === 0) return <div style={{ height: height + 16 }} />;
  const max = Math.max(1, ...bars.map((b) => b.segments.reduce((s, seg) => s + seg.value, 0)));

  // Laid out in HTML rather than SVG. The SVG version scaled its viewBox
  // non-uniformly to fill the width, which stretched every corner radius
  // horizontally — the pill caps flattened out and read as square ends.
  // Real elements keep their border-radius exactly, at any width.
  return (
    <div className="w-full">
      <div className="flex items-end justify-between gap-1" style={{ height }}>
        {bars.map((b, i) => {
          const total = b.segments.reduce((s, seg) => s + seg.value, 0);
          const pct = (total / max) * 100;
          return (
            <div key={b.label} className="flex-1 min-w-0 h-full flex flex-col justify-end items-center">
              {total === 0 ? (
                // A months-with-nothing marker, still fully rounded.
                <div className="w-full max-w-[18px] h-[3px] rounded-full bg-hairline" />
              ) : (
                <div
                  // overflow-hidden + a full radius on the column clips the
                  // segment joins square while both ends of the stack stay
                  // round, which is how the mockup draws them.
                  className="w-full max-w-[18px] rounded-full overflow-hidden flex flex-col chart-bar-grow origin-bottom"
                  style={{ height: `${pct}%`, animationDelay: `${i * 0.03}s` }}
                >
                  {b.segments.map((seg, si) => (
                    <div
                      key={si}
                      style={{
                        height: `${total > 0 ? (seg.value / total) * 100 : 0}%`,
                        background: seg.color ?? SERIES_COLORS[si % SERIES_COLORS.length],
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-start justify-between gap-1 mt-1.5">
        {bars.map((b) => (
          <div
            key={b.label}
            className="flex-1 min-w-0 text-center text-[9px] leading-none text-secondary uppercase tracking-wide truncate"
          >
            {b.label}
          </div>
        ))}
      </div>
    </div>
  );
}

export interface DonutSlice {
  label: string;
  value: number;
  color?: string;
}

export function DonutChart({
  slices,
  total,
  size = 140,
  centerLabel,
  showLegend = true,
}: {
  slices: DonutSlice[];
  total?: number;
  size?: number;
  centerLabel?: string;
  // Callers that render their own legend (e.g. the Dashboard's enlarged
  // Expense widget, legend-left per the mockup) opt out of this built-in
  // one to avoid showing the categories twice.
  showLegend?: boolean;
}) {
  const sum = total ?? slices.reduce((s, sl) => s + sl.value, 0);
  const r = size / 2;
  const stroke = size * 0.22;
  const radius = r - stroke / 2;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;
  const nonZero = slices.filter((s) => s.value > 0);

  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 chart-fade-in">
        <circle cx={r} cy={r} r={radius} fill="none" stroke="var(--hairline)" strokeWidth={stroke} />
        {sum > 0 &&
          nonZero.map((s, i) => {
            const frac = s.value / sum;
            const dash = frac * circumference;
            const el = (
              <circle
                key={s.label}
                cx={r}
                cy={r}
                r={radius}
                fill="none"
                stroke={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]}
                strokeWidth={stroke}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offset}
                transform={`rotate(-90 ${r} ${r})`}
                strokeLinecap="butt"
              />
            );
            offset += dash;
            return el;
          })}
        <text x={r} y={r} textAnchor="middle" dominantBaseline="central" fontSize={size * 0.16} fontWeight={700} fill="var(--text-primary)">
          {centerLabel}
        </text>
      </svg>
      {showLegend && (
        <div className="flex flex-col gap-1.5 min-w-0">
          {slices.map((s, i) => (
            <div key={s.label} className="flex items-center gap-2 text-caption min-w-0">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ background: s.color ?? SERIES_COLORS[i % SERIES_COLORS.length] }}
              />
              <span className="text-secondary truncate">{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RingProgress({
  value,
  max,
  size = 64,
  label,
}: {
  value: number;
  max: number;
  size?: number;
  label?: string;
}) {
  const r = size / 2;
  const stroke = size * 0.14;
  const radius = r - stroke / 2;
  const circumference = 2 * Math.PI * radius;
  const frac = max > 0 ? Math.min(1, value / max) : 0;
  const dash = frac * circumference;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 chart-fade-in">
      <circle cx={r} cy={r} r={radius} fill="none" stroke="var(--hairline)" strokeWidth={stroke} />
      <circle
        cx={r}
        cy={r}
        r={radius}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={stroke}
        strokeDasharray={`${dash} ${circumference - dash}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${r} ${r})`}
      />
      <text x={r} y={r} textAnchor="middle" dominantBaseline="central" fontSize={size * 0.28} fontWeight={700} fill="var(--text-primary)">
        {label ?? value}
      </text>
    </svg>
  );
}
