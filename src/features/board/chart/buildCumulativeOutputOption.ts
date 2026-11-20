import type { EChartsCoreOption } from 'echarts/core'
import {
  SHIFT_HOURS,
  calcMaxCap,
  calcUnitsPerHour,
  clampCount,
  formatLocalTime,
  type CycleSeconds,
  type ShiftInfo,
} from '@/utils/shiftCalculator'

export interface HourlyCumulativePoint {
  /** 小時標籤，如 '08:00' ~ '16:00'（共 9 個時間點：0h..8h） */
  hourLabel: string
  /** 已經過小時數 (0..8) */
  elapsedHours: number
  /** 實際累計產量（尚未到達的未來小時為 null） */
  actualCumulative: number | null
}

export interface CumulativeChartInput {
  cycleSeconds: CycleSeconds
  points: HourlyCumulativePoint[]
  /** 落後警示門檻（件數）；未提供時預設為每小時理想產出的 15% */
  lagThreshold?: number
}

export interface LagInterval {
  startLabel: string
  endLabel: string
  atIndex: number
  ideal: number
  actual: number
  lag: number
}

export function calcDefaultLagThreshold(cycleSeconds: CycleSeconds): number {
  return Math.max(1, Math.round(calcUnitsPerHour(cycleSeconds) * 0.15))
}

export function calcIdealAtElapsedHours(
  elapsedHours: number,
  cycleSeconds: CycleSeconds,
): number {
  const cap = calcMaxCap(cycleSeconds)
  const clampedHours = Math.max(0, Math.min(SHIFT_HOURS, elapsedHours))
  return Math.min(Math.floor((clampedHours * 3600) / cycleSeconds), cap)
}

/**
 * 偵測掉拍區間：當某小時點的「理想值 − 實際累計值 > lagThreshold」時標記該區間。
 */
export function detectLagIntervals(
  points: HourlyCumulativePoint[],
  lagThreshold: number,
  cycleSeconds: CycleSeconds = 10,
): LagInterval[] {
  const intervals: LagInterval[] = []
  for (let i = 0; i < points.length; i++) {
    const point = points[i]
    if (!point || point.actualCumulative === null) continue
    const ideal = calcIdealAtElapsedHours(point.elapsedHours, cycleSeconds)
    const lag = ideal - point.actualCumulative
    if (lag > lagThreshold) {
      const prev = points[Math.max(0, i - 1)]
      intervals.push({
        startLabel: prev?.hourLabel ?? point.hourLabel,
        endLabel: point.hourLabel,
        atIndex: i,
        ideal,
        actual: point.actualCumulative,
        lag,
      })
    }
  }
  return intervals
}

/**
 * 建立「本班每小時產出累計曲線圖」ECharts Option（雙 Y 軸 + 雙系列折線圖）。
 * - 左 Y 軸：累計產量（件），上限鎖定為動態 maxCap
 * - 右 Y 軸：班別上限達成進度（0% ~ 100%）
 * - 系列 A（理想基準線）：虛線，斜率為 calcUnitsPerHour(cycleSeconds)
 * - 系列 B（實際累計產量）：平滑實線，含掉拍區間 markArea 與紅點警示 markPoint
 */
export function buildCumulativeOutputOption(
  input: CumulativeChartInput,
): EChartsCoreOption {
  const { cycleSeconds, points } = input
  const maxCap = calcMaxCap(cycleSeconds)
  const unitsPerHour = calcUnitsPerHour(cycleSeconds)
  const threshold = input.lagThreshold ?? calcDefaultLagThreshold(cycleSeconds)

  const xLabels = points.map((p) => p.hourLabel)
  const idealSeries = points.map((p) =>
    calcIdealAtElapsedHours(p.elapsedHours, cycleSeconds),
  )
  const actualSeries = points.map((p) =>
    p.actualCumulative === null ? null : clampCount(p.actualCumulative, maxCap),
  )

  const lagIntervals = detectLagIntervals(points, threshold, cycleSeconds)

  const markAreaData = lagIntervals.map((item) => [
    { name: `掉拍 -${item.lag}`, xAxis: item.startLabel },
    { xAxis: item.endLabel },
  ])

  const markPointData = lagIntervals.map((item) => ({
    name: '掉拍警示',
    coord: [item.endLabel, clampCount(item.actual, maxCap)] as [string, number],
    value: `-${item.lag} 件`,
  }))

  return {
    backgroundColor: 'transparent',
    color: ['#38bdf8', '#22c55e'],
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(15, 23, 42, 0.95)',
      borderColor: '#334155',
      textStyle: { color: '#f8fafc', fontSize: 12 },
    },
    legend: {
      top: 4,
      textStyle: { color: '#cbd5e1' },
    },
    grid: {
      top: 44,
      left: 58,
      right: 58,
      bottom: 32,
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: xLabels,
      axisLine: { lineStyle: { color: '#475569' } },
      axisLabel: { color: '#94a3b8' },
    },
    yAxis: [
      {
        type: 'value',
        name: '累計產量 (件)',
        min: 0,
        max: maxCap,
        nameTextStyle: { color: '#94a3b8' },
        axisLabel: { color: '#94a3b8' },
        splitLine: { lineStyle: { color: '#1e293b' } },
      },
      {
        type: 'value',
        name: '上限進度 (%)',
        min: 0,
        max: 100,
        nameTextStyle: { color: '#94a3b8' },
        axisLabel: { color: '#94a3b8', formatter: '{value}%' },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: `理想基準線 (${unitsPerHour} 件/h)`,
        type: 'line',
        yAxisIndex: 0,
        smooth: false,
        symbol: 'none',
        lineStyle: { type: 'dashed', width: 2, color: '#38bdf8' },
        data: idealSeries,
        markLine: {
          symbol: 'none',
          silent: true,
          label: {
            color: '#f59e0b',
            formatter: `物理上限 ${maxCap} 件`,
            position: 'insideEndTop',
          },
          lineStyle: { color: '#f59e0b', type: 'dotted', width: 1.5 },
          data: [{ yAxis: maxCap }],
        },
      },
      {
        name: '實際累計產量',
        type: 'line',
        yAxisIndex: 0,
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { type: 'solid', width: 3, color: '#22c55e' },
        itemStyle: { color: '#22c55e' },
        areaStyle: { color: 'rgba(34, 197, 94, 0.10)' },
        data: actualSeries,
        markArea: {
          silent: true,
          itemStyle: { color: 'rgba(239, 68, 68, 0.18)' },
          label: { color: '#fca5a5', fontSize: 11, position: 'insideTop' },
          data: markAreaData,
        },
        markPoint: {
          symbol: 'circle',
          symbolSize: 12,
          itemStyle: { color: '#ef4444', borderColor: '#fecaca', borderWidth: 2 },
          label: {
            show: true,
            position: 'top',
            color: '#fca5a5',
            fontWeight: 'bold',
            formatter: '{c}',
          },
          data: markPointData,
        },
      },
    ],
  }
}

/**
 * 產生原型展示用的本班 0h~8h 每小時模擬資料（含第 2~3 小時模擬設備安燈掉拍情境）。
 */
export function generateSampleHourlyPoints(
  shift: ShiftInfo,
  cycleSeconds: CycleSeconds,
  options: { elapsedHours?: number; simulateDrop?: boolean } = {},
): HourlyCumulativePoint[] {
  const { elapsedHours = 8, simulateDrop = true } = options
  const unitsPerHour = calcUnitsPerHour(cycleSeconds)
  const cap = calcMaxCap(cycleSeconds)

  // 各小時達成效率（simulateDrop=true 時，第 2、3 小時受設備停機影響掉拍）
  const hourlyEfficiency = simulateDrop
    ? [1, 0.99, 0.55, 0.65, 1.0, 1.0, 1.0, 1.02]
    : [1, 1.0, 0.98, 0.99, 1.0, 1.0, 0.99, 1.0]

  const points: HourlyCumulativePoint[] = []
  let cumulative = 0

  for (let h = 0; h <= SHIFT_HOURS; h++) {
    const timestamp = shift.shiftStartTime + h * 3_600_000
    const hourLabel = formatLocalTime(timestamp)

    if (h === 0) {
      points.push({ hourLabel, elapsedHours: 0, actualCumulative: 0 })
      continue
    }

    if (h > elapsedHours) {
      points.push({ hourLabel, elapsedHours: h, actualCumulative: null })
      continue
    }

    const eff = hourlyEfficiency[h - 1] ?? 1
    cumulative = clampCount(cumulative + Math.round(unitsPerHour * eff), cap)
    points.push({ hourLabel, elapsedHours: h, actualCumulative: cumulative })
  }

  return points
}
