/**
 * ProductionAdapter — 資料來源抽象層（findings.md §4.10，決策 D3/R8）。
 *
 * UI 與 store 只能依賴本檔的介面與 DTO；Mock 模擬器、未來的 WebSocket / REST 實作
 * 都放在 services/adapters/ 之下，彼此可替換。
 */
import type { CycleSeconds, ShiftInfo } from '@/utils/shiftCalculator'

export type AndonType = 'QUALITY' | 'EQUIPMENT' | 'MATERIAL' | 'SAFETY'
export type AndonAction = 'RAISE' | 'RESOLVE'

export interface AndonReport {
  /** 冪等鍵：同一鍵重送多次，伺服端只記錄一次 */
  idempotencyKey: string
  /** 同一筆安燈的 RAISE / RESOLVE 共用 alertId */
  alertId: string
  action: AndonAction
  type: AndonType
  lineId: string
  stationId: string
  /** 模擬時間戳（epoch ms） */
  occurredAt: number
  note?: string
}

export interface AndonAck {
  idempotencyKey: string
  alertId: string
  acceptedAt: number
  /** true = 此鍵先前已處理過，本次未重複寫入 */
  duplicate: boolean
}

export interface LineSnapshot {
  lineId: string
  at: number
  shift: ShiftInfo
  cycleSeconds: CycleSeconds
  /** 感測器原始計數（可能因彈跳而超量，保留供稽核） */
  rawCount: number
  /** 經 clampCount(rawCount, maxCap) 後的顯示值 */
  count: number
  maxCap: number
  theoretical: number
  activeAlerts: AndonReport[]
}

export type ProductionEvent =
  | { type: 'COUNT_UPDATED'; lineId: string; at: number; rawCount: number }
  | { type: 'ANDON_RAISED'; report: AndonReport }
  | { type: 'ANDON_RESOLVED'; report: AndonReport }
  | { type: 'CYCLE_CHANGED'; lineId: string; at: number; cycleSeconds: CycleSeconds }

export type ConnectionStatus = 'connecting' | 'online' | 'offline'

export type Unsubscribe = () => void

export interface ProductionAdapter {
  readonly kind: 'mock' | 'websocket' | 'rest'
  connect(): Promise<void>
  disconnect(): void
  getConnectionStatus(): ConnectionStatus
  getSnapshot(lineId: string): Promise<LineSnapshot>
  /** 必須冪等：以 idempotencyKey 去重；網路失敗時拋出 AdapterNetworkError */
  submitAndonReport(report: AndonReport): Promise<AndonAck>
  subscribe(listener: (event: ProductionEvent) => void): Unsubscribe
  onConnectionChange(listener: (status: ConnectionStatus) => void): Unsubscribe
}

/** 可重試的網路錯誤 — 離線佇列只對此類錯誤重送 */
export class AdapterNetworkError extends Error {
  override readonly name = 'AdapterNetworkError'
}

/** 不可重試的請求錯誤（驗證失敗、4xx 類） */
export class AdapterRequestError extends Error {
  override readonly name = 'AdapterRequestError'
}

export class AdapterNotImplementedError extends Error {
  override readonly name = 'AdapterNotImplementedError'
}

export function isRetryableAdapterError(error: unknown): error is AdapterNetworkError {
  return error instanceof AdapterNetworkError
}

const ANDON_TYPES: readonly AndonType[] = ['QUALITY', 'EQUIPMENT', 'MATERIAL', 'SAFETY']
const ANDON_ACTIONS: readonly AndonAction[] = ['RAISE', 'RESOLVE']

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

/** 執行期驗證（資料可能來自 localStorage / BroadcastChannel / 網路，型別不可信） */
export function isAndonReport(value: unknown): value is AndonReport {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    nonEmpty(r.idempotencyKey) &&
    nonEmpty(r.alertId) &&
    nonEmpty(r.lineId) &&
    nonEmpty(r.stationId) &&
    ANDON_ACTIONS.includes(r.action as AndonAction) &&
    ANDON_TYPES.includes(r.type as AndonType) &&
    typeof r.occurredAt === 'number' &&
    Number.isFinite(r.occurredAt) &&
    (r.note === undefined || typeof r.note === 'string')
  )
}
