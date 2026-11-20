import { describe, expect, it } from 'vitest'
import {
  buildCumulativeOutputOption,
  detectLagIntervals,
  generateSampleHourlyPoints,
  type HourlyCumulativePoint,
} from '@/features/board/chart/buildCumulativeOutputOption'
import { calcMaxCap, calcUnitsPerHour, resolveShift, type CycleSeconds } from '@/utils/shiftCalculator'

const tpe = (isoLocal: string): number => Date.parse(`${isoLocal}+08:00`)

interface ChartSeriesStub {
  name: string
  lineStyle?: { type?: string }
  data?: Array<number | null>
  markArea?: { data?: unknown[] }
  markPoint?: { data?: Array<{ coord: [string, number]; value: string }> }
}

describe('buildCumulativeOutputOption', () => {
  it.each([5, 10, 30, 60] as const satisfies readonly CycleSeconds[])(
    'cycle %is 下理想基準線為虛線，每小時斜率與第 8 小時終點符合動態公式 maxCap',
    (cycle) => {
      const shift = resolveShift(tpe('2026-11-20T09:00:00.000'))
      const points = generateSampleHourlyPoints(shift, cycle, { simulateDrop: false })
      const option = buildCumulativeOutputOption({ cycleSeconds: cycle, points })

      const series = option.series as ChartSeriesStub[]
      const idealSeries = series[0]
      const actualSeries = series[1]

      expect(idealSeries?.lineStyle?.type).toBe('dashed')
      expect(actualSeries?.lineStyle?.type).toBe('solid')

      const unitsPerHour = calcUnitsPerHour(cycle)
      const expectedCap = calcMaxCap(cycle)
      expect(idealSeries?.data?.[0]).toBe(0)
      expect(idealSeries?.data?.[1]).toBe(unitsPerHour)
      expect(idealSeries?.data?.[8]).toBe(expectedCap)

      const leftYAxis = (option.yAxis as Array<{ max?: number }>)[0]
      expect(leftYAxis?.max).toBe(expectedCap)
    },
  )

  it('當實際累計產量落後理想值超過門檻時，動態標記 markArea 掉拍區間與 markPoint 紅點警示', () => {
    const points: HourlyCumulativePoint[] = [
      { hourLabel: '08:00', elapsedHours: 0, actualCumulative: 0 },
      { hourLabel: '09:00', elapsedHours: 1, actualCumulative: 350 }, // 理想 360，落後 10（未超過 54）
      { hourLabel: '10:00', elapsedHours: 2, actualCumulative: 520 }, // 理想 720，落後 200（超過 54）
      { hourLabel: '11:00', elapsedHours: 3, actualCumulative: 880 }, // 理想 1080，落後 200（超過 54）
    ]

    const intervals = detectLagIntervals(points, 54, 10)
    expect(intervals).toHaveLength(2)
    expect(intervals[0]).toMatchObject({
      startLabel: '09:00',
      endLabel: '10:00',
      lag: 200,
    })

    const option = buildCumulativeOutputOption({
      cycleSeconds: 10,
      points,
      lagThreshold: 54,
    })
    const actualSeries = (option.series as ChartSeriesStub[])[1]

    expect(actualSeries?.markArea?.data).toHaveLength(2)
    expect(actualSeries?.markPoint?.data).toHaveLength(2)
    expect(actualSeries?.markPoint?.data?.[0]?.value).toBe('-200 件')
  })

  it('實際產量正常（未超門檻）與未來 null 時段不產生掉拍警示', () => {
    const points: HourlyCumulativePoint[] = [
      { hourLabel: '08:00', elapsedHours: 0, actualCumulative: 0 },
      { hourLabel: '09:00', elapsedHours: 1, actualCumulative: 355 },
      { hourLabel: '10:00', elapsedHours: 2, actualCumulative: null },
    ]

    const option = buildCumulativeOutputOption({ cycleSeconds: 10, points })
    const actualSeries = (option.series as ChartSeriesStub[])[1]
    expect(actualSeries?.markArea?.data).toEqual([])
    expect(actualSeries?.markPoint?.data).toEqual([])
  })
})
