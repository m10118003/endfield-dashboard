import { describe, expect, it } from 'vitest'
import {
  CYCLE_OPTIONS,
  SHIFT_MS,
  SHIFT_SECONDS,
  calcAchievementRate,
  calcElapsedSeconds,
  calcMaxCap,
  calcProjectedEndOfShift,
  calcTheoreticalOutput,
  calcUnitsPerHour,
  clampCount,
  formatLocalTime,
  getNextShift,
  hasCrossedShiftBoundary,
  isCycleSeconds,
  resolveShift,
  type CycleSeconds,
} from './shiftCalculator'

/** 以 Asia/Taipei 本地時間撰寫測試常數，與 CI 機器時區無關 */
const tpe = (isoLocal: string): number => Date.parse(`${isoLocal}+08:00`)

describe('calcMaxCap — 動態班別物理上限 Math.floor(28800 / cycleSeconds)', () => {
  it.each([
    [5, 5760],
    [10, 2880],
    [30, 960],
    [60, 480],
  ] as const)('cycle %is → maxCap %i', (cycle, expected) => {
    expect(calcMaxCap(cycle)).toBe(expected)
  })

  it('每個節拍選項都整除 28800（maxCap × cycle === SHIFT_SECONDS）', () => {
    expect(SHIFT_SECONDS).toBe(28_800)
    for (const cycle of CYCLE_OPTIONS) {
      expect(calcMaxCap(cycle) * cycle).toBe(SHIFT_SECONDS)
    }
  })

  it.each([0, -5, 7, Number.NaN, Number.POSITIVE_INFINITY])(
    '不合法節拍 %s 拋出 RangeError',
    (bad) => {
      expect(() => calcMaxCap(bad as CycleSeconds)).toThrow(RangeError)
    },
  )

  it('isCycleSeconds 型別守衛', () => {
    expect(isCycleSeconds(10)).toBe(true)
    expect(isCycleSeconds(15)).toBe(false)
    expect(isCycleSeconds('10')).toBe(false)
  })
})

describe('calcUnitsPerHour — 理想基準線斜率', () => {
  it.each([
    [5, 720],
    [10, 360],
    [30, 120],
    [60, 60],
  ] as const)('cycle %is → %i 件/小時', (cycle, expected) => {
    expect(calcUnitsPerHour(cycle)).toBe(expected)
  })
})

describe('calcTheoreticalOutput — 時間漂移校準', () => {
  const start = tpe('2026-11-20T08:00:00.000')

  it('班別開始時為 0', () => {
    expect(calcTheoreticalOutput(start, start, 10)).toBe(0)
  })

  it('simNow 早於 shiftStartTime（時鐘偏差）時為 0，不會出現負值', () => {
    expect(calcTheoreticalOutput(start, start - 60_000, 10)).toBe(0)
  })

  it('未滿一個節拍不計件：9.999s @5s → 1', () => {
    expect(calcTheoreticalOutput(start, start + 9_999, 5)).toBe(1)
  })

  it('1 小時 @10s → 360', () => {
    expect(calcTheoreticalOutput(start, start + 3_600_000, 10)).toBe(360)
  })

  it.each(CYCLE_OPTIONS.map((c) => [c] as const))('班末與超時都收斂在 maxCap（cycle %is）', (cycle) => {
    expect(calcTheoreticalOutput(start, start + SHIFT_MS, cycle)).toBe(calcMaxCap(cycle))
    expect(calcTheoreticalOutput(start, start + SHIFT_MS * 3, cycle)).toBe(calcMaxCap(cycle))
  })

  it('只依賴時間差：一次跳 2 小時與逐秒累加結果相同（模擬背景分頁節流）', () => {
    const jumped = calcTheoreticalOutput(start, start + 7_200_000, 30)
    let stepped = 0
    for (let t = start; t <= start + 7_200_000; t += 1000) {
      stepped = calcTheoreticalOutput(start, t, 30)
    }
    expect(jumped).toBe(stepped)
    expect(jumped).toBe(240)
  })

  it('非有限時間戳不會產生 NaN', () => {
    expect(calcElapsedSeconds(Number.NaN, start)).toBe(0)
    expect(calcTheoreticalOutput(start, Number.NaN, 10)).toBe(0)
  })
})

describe('clampCount — Math.min(count, maxCap) 防呆', () => {
  it.each([
    [6000, 5760, 5760],
    [5760, 5760, 5760],
    [-3, 2880, 0],
    [12.7, 960, 12],
    [Number.NaN, 480, 0],
    [Number.POSITIVE_INFINITY, 480, 0],
    [100, 0, 0],
  ])('clampCount(%s, %s) → %s', (count, cap, expected) => {
    expect(clampCount(count, cap)).toBe(expected)
  })
})

describe('KPI 衍生值', () => {
  const start = tpe('2026-11-20T16:00:00.000')

  it('班末預估 = 實際 + 剩餘全速產出，不超過 maxCap', () => {
    // 中班過 4 小時、實際 1200 件 @10s：剩餘 4h → +1440 → 2640
    expect(calcProjectedEndOfShift(1200, start, start + 4 * 3_600_000, 10)).toBe(2640)
    // 超額輸入仍被收斂
    expect(calcProjectedEndOfShift(99_999, start, start, 10)).toBe(calcMaxCap(10))
  })

  it('達成率：理論值為 0 時回傳 null', () => {
    expect(calcAchievementRate(180, 360)).toBe(0.5)
    expect(calcAchievementRate(10, 0)).toBeNull()
  })
})

describe('resolveShift — 三班制與跨日 00:00 邊界（Asia/Taipei）', () => {
  it.each([
    ['2026-11-21T07:59:59.999', 'NIGHT', '2026-11-20'],
    ['2026-11-21T08:00:00.000', 'DAY', '2026-11-21'],
    ['2026-11-21T15:59:59.999', 'DAY', '2026-11-21'],
    ['2026-11-21T16:00:00.000', 'SWING', '2026-11-21'],
    ['2026-11-21T23:59:59.999', 'SWING', '2026-11-21'],
    ['2026-11-22T00:00:00.000', 'NIGHT', '2026-11-21'],
  ] as const)('%s → %s（生產日 %s）', (local, shiftId, businessDate) => {
    const shift = resolveShift(tpe(local))
    expect(shift.shiftId).toBe(shiftId)
    expect(shift.businessDate).toBe(businessDate)
    expect(shift.shiftKey).toBe(`${businessDate}#${shiftId}`)
  })

  it('23:59:59 屬於中班，班別結束時間為「隔日」00:00:00', () => {
    const swing = resolveShift(tpe('2026-11-20T23:59:59.000'))
    expect(swing.shiftId).toBe('SWING')
    expect(swing.label).toBe('中班')
    expect(swing.shiftStartTime).toBe(tpe('2026-11-20T16:00:00.000'))
    expect(swing.shiftEndTime).toBe(tpe('2026-11-21T00:00:00.000'))
  })

  it('00:00:00 進入晚班，晚班 00:00–08:00 歸屬前一個生產日', () => {
    const night = resolveShift(tpe('2026-11-21T00:00:00.000'))
    expect(night.shiftId).toBe('NIGHT')
    expect(night.shiftStartTime).toBe(tpe('2026-11-21T00:00:00.000'))
    expect(night.shiftEndTime).toBe(tpe('2026-11-21T08:00:00.000'))
    expect(night.businessDate).toBe('2026-11-20')
  })

  it('23:59:59 → 00:00:00 跨越班別邊界；同一班內不算跨越', () => {
    expect(
      hasCrossedShiftBoundary(tpe('2026-11-20T23:59:59.000'), tpe('2026-11-21T00:00:00.000')),
    ).toBe(true)
    expect(
      hasCrossedShiftBoundary(tpe('2026-11-21T00:00:00.000'), tpe('2026-11-21T07:59:59.999')),
    ).toBe(false)
  })

  it('每個班別長度都是 8 小時', () => {
    for (const local of ['2026-11-21T03:00:00', '2026-11-21T09:00:00', '2026-11-21T20:00:00']) {
      const s = resolveShift(tpe(local))
      expect(s.shiftEndTime - s.shiftStartTime).toBe(SHIFT_MS)
    }
  })

  it('不合法時間戳拋出 RangeError', () => {
    expect(() => resolveShift(Number.NaN)).toThrow(RangeError)
  })

  it('時區偏移為參數：同一 epoch 在 UTC+0 判斷結果不同', () => {
    const epoch = tpe('2026-11-21T00:30:00.000') // = 2026-11-20T16:30Z
    expect(resolveShift(epoch).shiftId).toBe('NIGHT')
    expect(resolveShift(epoch, 0).shiftId).toBe('SWING')
  })
})

describe('getNextShift — 換班順序與跨日/跨月/跨年', () => {
  it('早班 → 中班 → 晚班（跨日）→ 早班', () => {
    const day = resolveShift(tpe('2026-11-20T10:00:00'))
    const swing = getNextShift(day)
    const night = getNextShift(swing)
    const nextDay = getNextShift(night)
    expect([day, swing, night, nextDay].map((s) => s.shiftKey)).toEqual([
      '2026-11-20#DAY',
      '2026-11-20#SWING',
      '2026-11-20#NIGHT',
      '2026-11-21#DAY',
    ])
    expect(night.shiftStartTime).toBe(tpe('2026-11-21T00:00:00.000'))
  })

  it('跨月：11/30 中班 → 12/01 00:00 晚班（生產日仍為 11/30）', () => {
    const night = getNextShift(resolveShift(tpe('2026-11-30T23:59:59')))
    expect(night.shiftStartTime).toBe(tpe('2026-12-01T00:00:00.000'))
    expect(night.shiftKey).toBe('2026-11-30#NIGHT')
  })

  it('跨年：12/31 中班 → 2027-01-01 晚班 → 2027-01-01 早班', () => {
    const night = getNextShift(resolveShift(tpe('2026-12-31T23:59:59')))
    expect(night.shiftKey).toBe('2026-12-31#NIGHT')
    expect(getNextShift(night).shiftKey).toBe('2027-01-01#DAY')
  })
})

describe('formatLocalTime', () => {
  it('以時區偏移格式化 HH:mm', () => {
    expect(formatLocalTime(tpe('2026-11-20T23:59:59'))).toBe('23:59')
    expect(formatLocalTime(tpe('2026-11-21T00:00:00'))).toBe('00:00')
  })
})
