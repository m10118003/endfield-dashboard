import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Toaster } from '@/components/ui/sonner'
import { CumulativeOutputChart } from '@/features/board/chart/CumulativeOutputChart'
import {
  calcDefaultLagThreshold,
  detectLagIntervals,
  generateSampleHourlyPoints,
} from '@/features/board/chart/buildCumulativeOutputOption'
import { MockProductionAdapter } from '@/services/adapters/mockProductionAdapter'
import { AdapterNetworkError, type AndonReport } from '@/services/productionAdapter'
import {
  CYCLE_OPTIONS,
  calcAchievementRate,
  calcMaxCap,
  calcTheoreticalOutput,
  calcUnitsPerHour,
  clampCount,
  formatLocalTime,
  getNextShift,
  resolveShift,
  type CycleSeconds,
} from '@/utils/shiftCalculator'

type ShiftScenarioKey = 'day' | 'pre-midnight' | 'post-midnight'

const SCENARIO_PRESETS: Record<
  ShiftScenarioKey,
  { label: string; isoLocal: string; elapsedHours: number }
> = {
  day: {
    label: '早班進行中（12:00）',
    isoLocal: '2026-11-20T12:00:00.000',
    elapsedHours: 4,
  },
  'pre-midnight': {
    label: '中班跨日前（23:59:59）',
    isoLocal: '2026-11-20T23:59:59.000',
    elapsedHours: 8,
  },
  'post-midnight': {
    label: '晚班跨日後（00:00:00）',
    isoLocal: '2026-11-21T00:00:00.000',
    elapsedHours: 1,
  },
}

export function App() {
  const adapterRef = useRef<MockProductionAdapter | null>(null)
  if (!adapterRef.current) {
    adapterRef.current = new MockProductionAdapter({ cycleSeconds: 10, online: true })
  }

  const [cycleSeconds, setCycleSeconds] = useState<CycleSeconds>(10)
  const [pendingCycle, setPendingCycle] = useState<CycleSeconds | null>(null)
  const [scenario, setScenario] = useState<ShiftScenarioKey>('day')
  const [simulateDrop, setSimulateDrop] = useState(true)
  const [isOnline, setIsOnline] = useState(true)
  const [outboxCount, setOutboxCount] = useState(0)
  const [handoverOpen, setHandoverOpen] = useState(false)

  const currentPreset = SCENARIO_PRESETS[scenario]
  const simNow = Date.parse(`${currentPreset.isoLocal}+08:00`)

  const shift = useMemo(() => resolveShift(simNow), [simNow])
  const nextShift = useMemo(() => getNextShift(shift), [shift])

  const maxCap = calcMaxCap(cycleSeconds)
  const unitsPerHour = calcUnitsPerHour(cycleSeconds)
  const theoretical = calcTheoreticalOutput(shift.shiftStartTime, simNow, cycleSeconds)

  const points = useMemo(
    () =>
      generateSampleHourlyPoints(shift, cycleSeconds, {
        elapsedHours: currentPreset.elapsedHours,
        simulateDrop,
      }),
    [shift, cycleSeconds, currentPreset.elapsedHours, simulateDrop],
  )

  const latestActualRaw = useMemo(() => {
    const valid = points.filter((p) => p.actualCumulative !== null)
    return valid[valid.length - 1]?.actualCumulative ?? 0
  }, [points])

  const actualCount = clampCount(latestActualRaw, maxCap)
  const capProgressPercent = maxCap > 0 ? Math.min(100, Math.round((actualCount / maxCap) * 100)) : 0
  const achievement = calcAchievementRate(actualCount, theoretical)
  const lagThreshold = calcDefaultLagThreshold(cycleSeconds)
  const lagIntervals = useMemo(
    () => detectLagIntervals(points, lagThreshold, cycleSeconds),
    [points, lagThreshold, cycleSeconds],
  )

  function handleCycleSelectChange(value: string) {
    const parsed = Number(value) as CycleSeconds
    if (parsed === cycleSeconds) return
    setPendingCycle(parsed)
  }

  function confirmCycleChange() {
    if (pendingCycle === null) return
    setCycleSeconds(pendingCycle)
    adapterRef.current?.setCycleSeconds(pendingCycle)
    toast.success(`已切換節拍為 ${pendingCycle}s/件（物理上限 maxCap = ${calcMaxCap(pendingCycle)} 件）`)
    setPendingCycle(null)
  }

  function handleToggleNetwork() {
    const nextOnline = !isOnline
    setIsOnline(nextOnline)
    adapterRef.current?.setOnline(nextOnline)
    if (!nextOnline) {
      toast.warning('已切換為離線模擬：安燈回報將暫存至離線佇列 (Offline Queue)')
    } else {
      const flushed = outboxCount
      setOutboxCount(0)
      toast.success(
        flushed > 0
          ? `網路已恢復連線：已自動重送 ${flushed} 筆離線安燈事件（冪等去重完成）`
          : '網路已恢復連線',
      )
    }
  }

  async function handleRaiseSampleAndon() {
    const adapter = adapterRef.current
    if (!adapter) return
    const report: AndonReport = {
      idempotencyKey: `idem-${Date.now()}`,
      alertId: `alert-${Date.now()}`,
      action: 'RAISE',
      type: 'EQUIPMENT',
      lineId: 'LINE-A1',
      stationId: 'ST-03',
      occurredAt: simNow,
      note: '設備感測節拍異常掉拍',
    }
    try {
      await adapter.submitAndonReport(report)
      toast.success('已送出設備安燈回報（線上即時同步）')
    } catch (err) {
      if (err instanceof AdapterNetworkError) {
        setOutboxCount((c) => c + 1)
        toast.error('目前處於離線狀態：安燈事件已存入離線佇列並樂觀更新 UI')
      }
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <Toaster position="top-right" richColors />

      <div className="mx-auto max-w-6xl space-y-6">
        {/* 頂部戰情室標題與操作列 */}
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">
                IIoT 產線安燈戰情室（Andon Dashboard）
              </h1>
              <Badge variant={isOnline ? 'default' : 'destructive'}>
                {isOnline ? 'ONLINE' : `OFFLINE · 待送 ${outboxCount} 筆`}
              </Badge>
              {lagIntervals.length > 0 && (
                <Badge variant="destructive">掉拍警示 {lagIntervals.length} 區間</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              產線 LINE-A1 · 生產日 {shift.businessDate} · {shift.label}（
              {formatLocalTime(shift.shiftStartTime)}–{formatLocalTime(shift.shiftEndTime)}）·
              節拍 {cycleSeconds}s/件（{unitsPerHour} 件/小時）
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Select value={String(cycleSeconds)} onValueChange={handleCycleSelectChange}>
              <SelectTrigger className="w-[180px]" aria-label="選擇機型節拍週期">
                <SelectValue placeholder="選擇節拍週期" />
              </SelectTrigger>
              <SelectContent>
                {CYCLE_OPTIONS.map((c) => (
                  <SelectItem key={c} value={String(c)}>
                    {c}s/件（上限 {calcMaxCap(c)}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant={isOnline ? 'outline' : 'destructive'}
              onClick={handleToggleNetwork}
            >
              {isOnline ? '模擬網路斷線' : '恢復網路連線'}
            </Button>

            <Button variant="secondary" onClick={handleRaiseSampleAndon}>
              觸發安燈測試
            </Button>

            <Button onClick={() => setHandoverOpen(true)}>換班交接摘要</Button>
          </div>
        </header>

        {/* 跨日邊界與掉拍情境切換 */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {(Object.keys(SCENARIO_PRESETS) as ShiftScenarioKey[]).map((key) => (
              <Button
                key={key}
                size="sm"
                variant={scenario === key ? 'default' : 'outline'}
                onClick={() => setScenario(key)}
              >
                {SCENARIO_PRESETS[key].label}
              </Button>
            ))}
          </div>
          <Button
            size="sm"
            variant={simulateDrop ? 'destructive' : 'outline'}
            onClick={() => setSimulateDrop((v) => !v)}
          >
            {simulateDrop ? '掉拍模擬：開啟' : '掉拍模擬：關閉'}
          </Button>
        </div>

        {/* 核心 KPI 卡片列 */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>實際累計 / 理論產量</CardDescription>
              <CardTitle className="text-3xl tabular-nums">
                {actualCount} <span className="text-base text-muted-foreground">/ {theoretical} 件</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                班別鍵值：<code className="text-foreground">{shift.shiftKey}</code>
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>動態班別物理上限（28,800 / {cycleSeconds}s）</CardDescription>
              <CardTitle className="text-3xl tabular-nums">
                {maxCap} <span className="text-base text-muted-foreground">件</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Progress value={capProgressPercent} aria-label="班別產能進度" />
              <p className="text-xs text-muted-foreground">已達物理上限 {capProgressPercent}%</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>即時達成率 / 掉拍狀態</CardDescription>
              <CardTitle className="text-3xl tabular-nums">
                {achievement === null ? '—' : `${(achievement * 100).toFixed(1)}%`}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                掉拍警示門檻：落後理想基準 &gt; {lagThreshold} 件
              </p>
            </CardContent>
          </Card>
        </div>

        {/* ECharts 本班每小時產出累計曲線圖 */}
        <Card>
          <CardHeader>
            <CardTitle>本班每小時產出累計曲線圖</CardTitle>
            <CardDescription>
              系列 A 虛線為理想基準線（{unitsPerHour} 件/小時），系列 B 實線為實際累計產量；落後超過門檻自動標記紅色掉拍區間與警示點
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CumulativeOutputChart
              cycleSeconds={cycleSeconds}
              points={points}
              lagThreshold={lagThreshold}
            />
          </CardContent>
        </Card>
      </div>

      {/* Dialog 1：機型節拍切換二次確認 */}
      <Dialog open={pendingCycle !== null} onOpenChange={(open) => !open && setPendingCycle(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>確認切換產線機型節拍？</DialogTitle>
            <DialogDescription>
              將節拍從 {cycleSeconds}s/件 切換為 {pendingCycle ?? cycleSeconds}s/件 後，系統會即時依公式
              28,800 / {pendingCycle ?? cycleSeconds} 重算本班理想基準線與物理上限（
              {pendingCycle !== null ? calcMaxCap(pendingCycle) : maxCap} 件）。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingCycle(null)}>
              取消
            </Button>
            <Button onClick={confirmCycleChange}>確認切換</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog 2：換班交接摘要 */}
      <Dialog open={handoverOpen} onOpenChange={setHandoverOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>換班交接摘要（{shift.label} → {nextShift.label}）</DialogTitle>
            <DialogDescription>
              生產日 {shift.businessDate} · 班別鍵 {shift.shiftKey} 結算預覽
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">實際累計 / 理論產量</span>
              <span className="font-medium tabular-nums">
                {actualCount} / {theoretical} 件
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">班別物理上限 (maxCap)</span>
              <span className="font-medium tabular-nums">{maxCap} 件</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">偵測掉拍區間數</span>
              <span className="font-medium tabular-nums">{lagIntervals.length} 區間</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">下一班接續</span>
              <span className="font-medium">
                {nextShift.businessDate} {nextShift.label}（
                {formatLocalTime(nextShift.shiftStartTime)}–{formatLocalTime(nextShift.shiftEndTime)}）
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setHandoverOpen(false)}>關閉摘要</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default App
