import { useMemo } from 'react'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import { echarts } from '@/charts/echartsCore'
import {
  buildCumulativeOutputOption,
  type HourlyCumulativePoint,
} from '@/features/board/chart/buildCumulativeOutputOption'
import type { CycleSeconds } from '@/utils/shiftCalculator'

export interface CumulativeOutputChartProps {
  cycleSeconds: CycleSeconds
  points: HourlyCumulativePoint[]
  lagThreshold?: number
  className?: string
}

export function CumulativeOutputChart({
  cycleSeconds,
  points,
  lagThreshold,
  className,
}: CumulativeOutputChartProps) {
  const option = useMemo(
    () => buildCumulativeOutputOption({ cycleSeconds, points, lagThreshold }),
    [cycleSeconds, points, lagThreshold],
  )

  return (
    <ReactEChartsCore
      echarts={echarts}
      option={option}
      notMerge={true}
      lazyUpdate={true}
      className={className}
      style={{ height: '340px', width: '100%' }}
    />
  )
}
