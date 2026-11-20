import { describe, expect, it, vi } from 'vitest'
import { MockProductionAdapter } from '@/services/adapters/mockProductionAdapter'
import {
  AdapterNetworkError,
  AdapterRequestError,
  isAndonReport,
  isRetryableAdapterError,
  type AndonReport,
} from '@/services/productionAdapter'

const tpe = (isoLocal: string): number => Date.parse(`${isoLocal}+08:00`)

function makeReport(overrides: Partial<AndonReport> = {}): AndonReport {
  return {
    idempotencyKey: 'idem-001',
    alertId: 'alert-001',
    action: 'RAISE',
    type: 'EQUIPMENT',
    lineId: 'LINE-A1',
    stationId: 'ST-03',
    occurredAt: tpe('2026-11-20T10:00:00.000'),
    ...overrides,
  }
}

describe('productionAdapter helpers', () => {
  it('isAndonReport 驗證必要欄位與列舉值', () => {
    expect(isAndonReport(makeReport())).toBe(true)
    expect(isAndonReport(null)).toBe(false)
    expect(isAndonReport(makeReport({ idempotencyKey: '   ' }))).toBe(false)
    expect(isAndonReport(makeReport({ occurredAt: Number.NaN }))).toBe(false)
    expect(isAndonReport({ ...makeReport(), action: 'UNKNOWN' })).toBe(false)
  })

  it('isRetryableAdapterError 僅對 AdapterNetworkError 回傳 true', () => {
    expect(isRetryableAdapterError(new AdapterNetworkError('offline'))).toBe(true)
    expect(isRetryableAdapterError(new AdapterRequestError('bad payload'))).toBe(false)
    expect(isRetryableAdapterError(new Error('generic'))).toBe(false)
  })
})

describe('MockProductionAdapter', () => {
  it('getSnapshot 依動態公式計算 maxCap 並對超額 rawCount 執行 clampCount 防呆', async () => {
    const adapter = new MockProductionAdapter({
      cycleSeconds: 10,
      simNow: tpe('2026-11-20T10:00:00.000'), // 早班經過 2 小時
      rawCountOverride: 9999,
    })

    const snap = await adapter.getSnapshot('LINE-A1')
    expect(snap.maxCap).toBe(2880)
    expect(snap.theoretical).toBe(720)
    expect(snap.rawCount).toBe(9999)
    expect(snap.count).toBe(2880)
    expect(snap.shift.shiftId).toBe('DAY')
  })

  it('submitAndonReport 冪等去重：同一個 idempotencyKey 重送第二次回傳 duplicate=true 且不重複寫入', async () => {
    const adapter = new MockProductionAdapter({
      simNow: tpe('2026-11-20T10:05:00.000'),
    })
    const events: string[] = []
    adapter.subscribe((e) => events.push(e.type))

    const report = makeReport({ idempotencyKey: 'key-123', alertId: 'alt-1' })
    const first = await adapter.submitAndonReport(report)
    const second = await adapter.submitAndonReport(report)

    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(second.acceptedAt).toBe(first.acceptedAt)
    expect(events).toEqual(['ANDON_RAISED'])

    const snap = await adapter.getSnapshot('LINE-A1')
    expect(snap.activeAlerts).toHaveLength(1)

    // 解除安燈
    await adapter.submitAndonReport(
      makeReport({ idempotencyKey: 'key-124', alertId: 'alt-1', action: 'RESOLVE' }),
    )
    const afterResolve = await adapter.getSnapshot('LINE-A1')
    expect(afterResolve.activeAlerts).toHaveLength(0)
  })

  it('網路斷線時拋出 AdapterNetworkError（可重試），連線恢復後可正常送出', async () => {
    const adapter = new MockProductionAdapter({ online: true })
    const onConn = vi.fn()
    adapter.onConnectionChange(onConn)

    adapter.setOnline(false)
    expect(adapter.getConnectionStatus()).toBe('offline')
    expect(onConn).toHaveBeenCalledWith('offline')

    await expect(adapter.submitAndonReport(makeReport())).rejects.toThrow(AdapterNetworkError)

    try {
      await adapter.submitAndonReport(makeReport())
    } catch (err) {
      expect(isRetryableAdapterError(err)).toBe(true)
    }

    adapter.setOnline(true)
    expect(adapter.getConnectionStatus()).toBe('online')
    const ack = await adapter.submitAndonReport(makeReport())
    expect(ack.duplicate).toBe(false)
  })
})
