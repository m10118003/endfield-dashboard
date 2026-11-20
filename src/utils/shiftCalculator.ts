/**
 * shiftCalculator — 產能上限、理論產量與三班制班別判斷（純函式，無副作用）。
 *
 * 設計原則（見 findings.md §4.4、§4.6）：
 * - 「8 小時」只在這裡定義一次：SHIFT_SECONDS = 28_800。
 * - maxCap 一律由 Math.floor(SHIFT_SECONDS / cycleSeconds) 推導，不得寫死任何上限值。
 * - 理論產量只依賴時間戳差值（shiftStartTime vs simNow），與計時器 tick 次數無關 → 抗漂移。
 * - 班別以「固定時區偏移」計算，與執行環境時區無關；區間一律半開 [start, end)。
 * - 生產日（businessDate）從 08:00 起算：晚班 00:00–08:00 歸屬前一日（決策 Q1-A）。
 */

// ─── 產能 ──────────────────────────────────────────────────────────────

export const SHIFT_HOURS = 8
export const SHIFT_SECONDS = SHIFT_HOURS * 60 * 60 // 28_800
export const SHIFT_MS = SHIFT_SECONDS * 1000

export const CYCLE_OPTIONS = [5, 10, 30, 60] as const
export type CycleSeconds = (typeof CYCLE_OPTIONS)[number]

export function isCycleSeconds(value: unknown): value is CycleSeconds {
  return typeof value === 'number' && (CYCLE_OPTIONS as readonly number[]).includes(value)
}

function assertCycle(cycleSeconds: number): asserts cycleSeconds is CycleSeconds {
  if (!isCycleSeconds(cycleSeconds)) {
    throw new RangeError(
      `cycleSeconds must be one of ${CYCLE_OPTIONS.join('/')}, received ${String(cycleSeconds)}`,
    )
  }
}

/** 動態班別物理上限：Math.floor(28800 / cycleSeconds) */
export function calcMaxCap(cycleSeconds: CycleSeconds): number {
  assertCycle(cycleSeconds)
  return Math.floor(SHIFT_SECONDS / cycleSeconds)
}

/** 每小時理想產出（理想基準線斜率），例如 10s/件 → 360 件/小時 */
export function calcUnitsPerHour(cycleSeconds: CycleSeconds): number {
  assertCycle(cycleSeconds)
  return Math.floor(3600 / cycleSeconds)
}

/** 防呆：NaN / Infinity / 負數 / 小數 / 超過物理上限一律收斂到 [0, cap] 的整數 */
export function clampCount(count: number, cap: number): number {
  if (!Number.isFinite(count) || !Number.isFinite(cap) || cap <= 0) return 0
  return Math.max(0, Math.min(Math.floor(count), Math.floor(cap)))
}

/** 班內已經過秒數，限制在 [0, SHIFT_SECONDS] */
export function calcElapsedSeconds(shiftStartTime: number, simNow: number): number {
  if (!Number.isFinite(shiftStartTime) || !Number.isFinite(simNow)) return 0
  return Math.min(SHIFT_SECONDS, Math.max(0, (simNow - shiftStartTime) / 1000))
}

export function calcRemainingSeconds(shiftStartTime: number, simNow: number): number {
  return SHIFT_SECONDS - calcElapsedSeconds(shiftStartTime, simNow)
}

/**
 * 時間漂移校準：理論產量 = floor(經過秒數 / 節拍)，並以 maxCap 防呆。
 * 背景分頁被節流後回到前景，只要拿到正確的 simNow，結果就與連續 tick 完全一致。
 */
export function calcTheoreticalOutput(
  shiftStartTime: number,
  simNow: number,
  cycleSeconds: CycleSeconds,
): number {
  const elapsed = calcElapsedSeconds(shiftStartTime, simNow)
  return Math.min(Math.floor(elapsed / cycleSeconds), calcMaxCap(cycleSeconds))
}

/** 班末預估：目前實際 + 剩餘時間全速產出，仍不得超過 maxCap */
export function calcProjectedEndOfShift(
  actualCount: number,
  shiftStartTime: number,
  simNow: number,
  cycleSeconds: CycleSeconds,
): number {
  const cap = calcMaxCap(cycleSeconds)
  const remaining = calcRemainingSeconds(shiftStartTime, simNow)
  return clampCount(clampCount(actualCount, cap) + Math.floor(remaining / cycleSeconds), cap)
}

/** 達成率（0–1）；理論值為 0 時回傳 null（畫面顯示「—」） */
export function calcAchievementRate(actualCount: number, theoretical: number): number | null {
  if (!Number.isFinite(theoretical) || theoretical <= 0) return null
  return Math.max(0, actualCount) / theoretical
}

// ─── 三班制 ────────────────────────────────────────────────────────────

export type ShiftId = 'DAY' | 'SWING' | 'NIGHT'

export const SHIFT_LABELS: Readonly<Record<ShiftId, string>> = {
  NIGHT: '晚班',
  DAY: '早班',
  SWING: '中班',
}

/** 一天切成三段，索引 = floor(本地時間毫秒 / 8h)：0 → 晚班 00–08、1 → 早班 08–16、2 → 中班 16–24 */
const SHIFT_ORDER: readonly ShiftId[] = ['NIGHT', 'DAY', 'SWING']

/** 預設 Asia/Taipei（UTC+8，無日光節約）— 決策 Q6-A */
export const DEFAULT_TZ_OFFSET_MINUTES = 8 * 60

/** 生產日從 08:00 起算 */
const BUSINESS_DAY_START_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export interface ShiftInfo {
  shiftId: ShiftId
  label: string
  /** epoch ms，含 */
  shiftStartTime: number
  /** epoch ms，不含（半開區間） */
  shiftEndTime: number
  /** YYYY-MM-DD，生產日 */
  businessDate: string
  /** `${businessDate}#${shiftId}`，班別唯一鍵 */
  shiftKey: string
}

function toLocalMs(epochMs: number, tzOffsetMinutes: number): number {
  return epochMs + tzOffsetMinutes * 60_000
}

/** 以「位移後的 UTC」格式化，確保與執行環境時區無關 */
function formatIsoDate(localMs: number): string {
  return new Date(localMs).toISOString().slice(0, 10)
}

/** 格式化為本地 HH:mm（圖表 X 軸用） */
export function formatLocalTime(
  epochMs: number,
  tzOffsetMinutes: number = DEFAULT_TZ_OFFSET_MINUTES,
): string {
  return new Date(toLocalMs(epochMs, tzOffsetMinutes)).toISOString().slice(11, 16)
}

/** 判斷任一時間點所屬班別（含跨日 00:00 邊界） */
export function resolveShift(
  epochMs: number,
  tzOffsetMinutes: number = DEFAULT_TZ_OFFSET_MINUTES,
): ShiftInfo {
  if (!Number.isFinite(epochMs)) {
    throw new RangeError(`epochMs must be a finite number, received ${String(epochMs)}`)
  }
  const localMs = toLocalMs(epochMs, tzOffsetMinutes)
  const localDayStart = Math.floor(localMs / DAY_MS) * DAY_MS
  const index = Math.floor((localMs - localDayStart) / SHIFT_MS)
  const shiftId = SHIFT_ORDER[index]
  if (shiftId === undefined) throw new Error(`unreachable shift index ${index}`)

  const localStart = localDayStart + index * SHIFT_MS
  const shiftStartTime = localStart - tzOffsetMinutes * 60_000
  const businessDate = formatIsoDate(localStart - BUSINESS_DAY_START_MS)

  return {
    shiftId,
    label: SHIFT_LABELS[shiftId],
    shiftStartTime,
    shiftEndTime: shiftStartTime + SHIFT_MS,
    businessDate,
    shiftKey: `${businessDate}#${shiftId}`,
  }
}

/** 下一班：從本班結束時間（半開區間的第一個不屬於本班的毫秒）重新判斷 */
export function getNextShift(
  shift: ShiftInfo,
  tzOffsetMinutes: number = DEFAULT_TZ_OFFSET_MINUTES,
): ShiftInfo {
  return resolveShift(shift.shiftEndTime, tzOffsetMinutes)
}

/** 兩個時間點之間是否跨越班別邊界（例如 23:59:59 → 00:00:00） */
export function hasCrossedShiftBoundary(
  previousMs: number,
  nextMs: number,
  tzOffsetMinutes: number = DEFAULT_TZ_OFFSET_MINUTES,
): boolean {
  return (
    resolveShift(previousMs, tzOffsetMinutes).shiftKey !==
    resolveShift(nextMs, tzOffsetMinutes).shiftKey
  )
}
