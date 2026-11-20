import {
  AdapterNetworkError,
  AdapterRequestError,
  isAndonReport,
  type AndonAck,
  type AndonReport,
  type ConnectionStatus,
  type LineSnapshot,
  type ProductionAdapter,
  type ProductionEvent,
  type Unsubscribe,
} from '@/services/productionAdapter'
import {
  calcMaxCap,
  calcTheoreticalOutput,
  clampCount,
  resolveShift,
  type CycleSeconds,
} from '@/utils/shiftCalculator'

export interface MockProductionAdapterOptions {
  cycleSeconds?: CycleSeconds
  simNow?: number
  online?: boolean
  rawCountOverride?: number | null
}

/**
 * MockProductionAdapter — 單機模擬與單元測試用的 ProductionAdapter 實作。
 * 內建冪等鍵去重（processedAcks）與網路斷線模擬。
 */
export class MockProductionAdapter implements ProductionAdapter {
  readonly kind = 'mock' as const

  private cycleSeconds: CycleSeconds
  private simNow: number
  private online: boolean
  private connected = true
  private rawCountOverride: number | null
  private readonly processedAcks = new Map<string, AndonAck>()
  private readonly activeAlerts = new Map<string, AndonReport>()
  private readonly eventListeners = new Set<(event: ProductionEvent) => void>()
  private readonly connectionListeners = new Set<(status: ConnectionStatus) => void>()

  constructor(options: MockProductionAdapterOptions = {}) {
    this.cycleSeconds = options.cycleSeconds ?? 10
    this.simNow = options.simNow ?? Date.now()
    this.online = options.online ?? true
    this.rawCountOverride = options.rawCountOverride ?? null
  }

  async connect(): Promise<void> {
    this.connected = true
    this.notifyConnection()
  }

  disconnect(): void {
    this.connected = false
    this.notifyConnection()
  }

  getConnectionStatus(): ConnectionStatus {
    return this.connected && this.online ? 'online' : 'offline'
  }

  setOnline(online: boolean): void {
    this.online = online
    this.notifyConnection()
  }

  setCycleSeconds(cycleSeconds: CycleSeconds): void {
    this.cycleSeconds = cycleSeconds
  }

  setSimNow(simNow: number): void {
    this.simNow = simNow
  }

  setRawCountOverride(rawCount: number | null): void {
    this.rawCountOverride = rawCount
  }

  async getSnapshot(lineId: string): Promise<LineSnapshot> {
    const shift = resolveShift(this.simNow)
    const maxCap = calcMaxCap(this.cycleSeconds)
    const theoretical = calcTheoreticalOutput(
      shift.shiftStartTime,
      this.simNow,
      this.cycleSeconds,
    )
    const rawCount = this.rawCountOverride ?? theoretical
    const count = clampCount(rawCount, maxCap)

    return {
      lineId,
      at: this.simNow,
      shift,
      cycleSeconds: this.cycleSeconds,
      rawCount,
      count,
      maxCap,
      theoretical,
      activeAlerts: Array.from(this.activeAlerts.values()),
    }
  }

  async submitAndonReport(report: AndonReport): Promise<AndonAck> {
    if (!this.online || !this.connected) {
      throw new AdapterNetworkError('Simulated network offline')
    }
    if (!isAndonReport(report)) {
      throw new AdapterRequestError('Invalid AndonReport payload')
    }

    const existing = this.processedAcks.get(report.idempotencyKey)
    if (existing) {
      return { ...existing, duplicate: true }
    }

    const ack: AndonAck = {
      idempotencyKey: report.idempotencyKey,
      alertId: report.alertId,
      acceptedAt: this.simNow,
      duplicate: false,
    }
    this.processedAcks.set(report.idempotencyKey, ack)

    if (report.action === 'RAISE') {
      this.activeAlerts.set(report.alertId, report)
      this.emitEvent({ type: 'ANDON_RAISED', report })
    } else {
      this.activeAlerts.delete(report.alertId)
      this.emitEvent({ type: 'ANDON_RESOLVED', report })
    }

    return ack
  }

  subscribe(listener: (event: ProductionEvent) => void): Unsubscribe {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  onConnectionChange(listener: (status: ConnectionStatus) => void): Unsubscribe {
    this.connectionListeners.add(listener)
    return () => {
      this.connectionListeners.delete(listener)
    }
  }

  private emitEvent(event: ProductionEvent): void {
    for (const listener of this.eventListeners) {
      listener(event)
    }
  }

  private notifyConnection(): void {
    const status = this.getConnectionStatus()
    for (const listener of this.connectionListeners) {
      listener(status)
    }
  }
}
