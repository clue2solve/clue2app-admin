import { useEffect, useMemo, useState } from 'react'
import { Box, Card, CardContent, Typography, Chip, Stack, useTheme, Alert } from '@mui/material'
import { motion } from 'framer-motion'
import QueryStatsIcon from '@mui/icons-material/QueryStats'
import { coordinatorGet } from '../api'
import type { PricingRate } from './BillingTab'

// --- Validated historical data (2026-07 rate-rebase design doc) ------------
// AWS Cost Explorer actuals + runtime CCU-hr usage for Jan-Jul 2026 MTD.
// Retail $ shown for Mar-Jul is the *old* $0.015/CCU-hr rate as actually
// billed in those months (frozen — see V47 pricing_rate_history strategy).
// Jan/Feb predate CCU metering (n/a). This is a static, already-validated
// snapshot — not live-fetched — used purely to project what the same usage
// would have billed at each month's *effective* retail rate (fetched from
// /api/v1/billing/rate/history) for comparison, instead of a hardcoded
// "old vs new" split.
interface HistoricalMonth {
  label: string
  monthEnd: string // ISO date, end of month (or "today" for the MTD row) — used to join against effectiveFrom
  awsTotal: number
  fixed: number
  shared: number
  attributable: number
  runtimeCcuHours: number | null
  runtimeRetailOld: number | null
}

const HISTORY: HistoricalMonth[] = [
  { label: 'Jan 2026', monthEnd: '2026-01-31', awsTotal: 791.57, fixed: 343.12, shared: 259.38, attributable: 189.07, runtimeCcuHours: null, runtimeRetailOld: null },
  { label: 'Feb 2026', monthEnd: '2026-02-28', awsTotal: 679.83, fixed: 202.64, shared: 244.30, attributable: 232.89, runtimeCcuHours: null, runtimeRetailOld: null },
  { label: 'Mar 2026', monthEnd: '2026-03-31', awsTotal: 888.43, fixed: 221.11, shared: 287.21, attributable: 380.10, runtimeCcuHours: 67704, runtimeRetailOld: 1789.62 },
  { label: 'Apr 2026', monthEnd: '2026-04-30', awsTotal: 821.94, fixed: 214.94, shared: 280.56, attributable: 326.43, runtimeCcuHours: 65520, runtimeRetailOld: 1704.05 },
  { label: 'May 2026', monthEnd: '2026-05-31', awsTotal: 861.81, fixed: 221.11, shared: 293.01, attributable: 347.68, runtimeCcuHours: 67704, runtimeRetailOld: 1760.30 },
  { label: 'Jun 2026', monthEnd: '2026-06-30', awsTotal: 854.48, fixed: 214.95, shared: 282.19, attributable: 357.32, runtimeCcuHours: 56784, runtimeRetailOld: 1476.38 },
  { label: 'Jul MTD', monthEnd: '2026-07-31', awsTotal: 210.63, fixed: 66.99, shared: 60.90, attributable: 70.32, runtimeCcuHours: 25272, runtimeRetailOld: 657.25 },
]

// Picks the rate whose effectiveFrom is the most recent one on or before
// the given month-end — i.e. the rate that was actually in effect for that
// month. History is assumed sorted DESC by effectiveFrom (as returned by
// GET /api/v1/billing/rate/history), matching the coordinator's
// findAllByOrderByEffectiveFromDesc(). Months that predate every seeded rate
// (e.g. pre-V47 history) fall back to the earliest known rate rather than
// showing no projection at all — better an approximation than a gap.
function effectiveRateFor(monthEnd: string, rateHistory: PricingRate[]): PricingRate | null {
  if (rateHistory.length === 0) return null
  const monthEndMs = new Date(monthEnd).getTime()
  const inEffect = rateHistory.find((r) => new Date(r.effectiveFrom).getTime() <= monthEndMs)
  return inEffect ?? rateHistory[rateHistory.length - 1]
}

function projectedRetailAtEffectiveRate(ccuHours: number | null, rate: PricingRate | null): number | null {
  if (ccuHours === null || rate === null) return null
  return ccuHours * rate.retailRate
}

function formatUSD(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
}

// --- chart geometry ---------------------------------------------------------

const WIDTH = 720
const HEIGHT = 240
const PADDING = { top: 16, right: 16, bottom: 28, left: 56 }
const CHART_W = WIDTH - PADDING.left - PADDING.right
const CHART_H = HEIGHT - PADDING.top - PADDING.bottom

function buildPoints(values: (number | null)[], yMax: number): ({ x: number; y: number } | null)[] {
  const n = values.length
  return values.map((v, i) => {
    if (v === null) return null
    const x = n > 1 ? PADDING.left + (i * CHART_W) / (n - 1) : PADDING.left + CHART_W / 2
    const y = PADDING.top + CHART_H - (yMax === 0 ? 0 : (v / yMax) * CHART_H)
    return { x, y }
  })
}

function pointsToStr(points: ({ x: number; y: number } | null)[]): string {
  return points
    .filter((p): p is { x: number; y: number } => p !== null)
    .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ')
}

function HistoricalRateChart() {
  const theme = useTheme()
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [rateHistory, setRateHistory] = useState<PricingRate[] | null>(null)
  const [rateHistoryError, setRateHistoryError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    coordinatorGet<PricingRate[]>('/api/v1/billing/rate/history')
      .then((h) => {
        if (!cancelled) setRateHistory(h)
      })
      .catch((err) => {
        if (cancelled) return
        setRateHistoryError(err instanceof Error ? err.message : 'Failed to load rate history')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const monthRates = useMemo(
    () => HISTORY.map((m) => (rateHistory ? effectiveRateFor(m.monthEnd, rateHistory) : null)),
    [rateHistory],
  )

  const projected = useMemo(
    () => HISTORY.map((m, i) => projectedRetailAtEffectiveRate(m.runtimeCcuHours, monthRates[i])),
    [monthRates],
  )

  const { awsPoints, oldRetailPoints, newRetailPoints, gridLines } = useMemo(() => {
    const aws = HISTORY.map((m) => m.awsTotal)
    const oldRetail = HISTORY.map((m) => m.runtimeRetailOld ?? 0)
    const newRetail = projected.map((v) => v ?? 0)
    const maxVal = Math.max(1, ...aws, ...oldRetail, ...newRetail)
    const yMaxLocal = Math.ceil((maxVal * 1.1) / 100) * 100
    return {
      awsPoints: buildPoints(aws, yMaxLocal),
      oldRetailPoints: buildPoints(HISTORY.map((m) => m.runtimeRetailOld), yMaxLocal),
      newRetailPoints: buildPoints(projected, yMaxLocal),
      gridLines: [0, 0.25, 0.5, 0.75, 1].map((f) => ({
        value: yMaxLocal * f,
        y: PADDING.top + CHART_H - f * CHART_H,
      })),
    }
  }, [projected])

  const handleMouseMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * WIDTH
    const n = HISTORY.length
    let nearest = 0
    let best = Infinity
    for (let i = 0; i < n; i++) {
      const px = n > 1 ? PADDING.left + (i * CHART_W) / (n - 1) : PADDING.left + CHART_W / 2
      const d = Math.abs(px - relX)
      if (d < best) {
        best = d
        nearest = i
      }
    }
    setHoverIdx(nearest)
  }

  const hoverMonth = hoverIdx !== null ? HISTORY[hoverIdx] : null
  const hoverProjected = hoverIdx !== null ? projected[hoverIdx] : null
  const hoverRate = hoverIdx !== null ? monthRates[hoverIdx] : null
  const hoverAwsPoint = hoverIdx !== null ? awsPoints[hoverIdx] : null
  const latestRate = rateHistory && rateHistory.length > 0 ? rateHistory[0] : null

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
            <QueryStatsIcon color="primary" />
            <Typography variant="h6" fontWeight={600} sx={{ flexGrow: 1 }}>
              6-Month Rate Rebase Projection
            </Typography>
            <Stack direction="row" spacing={1}>
              <Chip label="AWS actual" size="small" variant="outlined" sx={{ color: 'text.secondary' }} />
              <Chip label="Billed rate (frozen)" size="small" variant="outlined" color="default" />
              <Chip
                label={latestRate ? `Effective rate ($${Number(latestRate.retailRate).toFixed(3)})` : 'Effective rate'}
                size="small"
                color="primary"
                variant="filled"
              />
            </Stack>
          </Box>
          {rateHistoryError && <Alert severity="warning" sx={{ mb: 2 }}>{rateHistoryError}</Alert>}
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Same metered runtime CCU-hrs, replayed at each month's effective retail rate from
            pricing_rate_history. Jan/Feb predate CCU metering. Historical months are frozen at
            their billed rate — this line is illustrative only.
          </Typography>

          <Box sx={{ position: 'relative', width: '100%', height: HEIGHT }}>
            <svg
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              width="100%"
              height={HEIGHT}
              preserveAspectRatio="none"
              style={{ overflow: 'visible' }}
            >
              {/* Y gridlines + labels */}
              {gridLines.map((g, i) => (
                <g key={i}>
                  <line
                    x1={PADDING.left}
                    x2={WIDTH - PADDING.right}
                    y1={g.y}
                    y2={g.y}
                    stroke="rgba(255,255,255,0.08)"
                    strokeWidth={1}
                  />
                  <text
                    x={PADDING.left - 8}
                    y={g.y + 4}
                    textAnchor="end"
                    fontSize={10}
                    fill="rgba(255,255,255,0.45)"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {formatUSD(g.value)}
                  </text>
                </g>
              ))}

              {/* X labels */}
              {HISTORY.map((m, i) => {
                const p = awsPoints[i]
                if (!p) return null
                return (
                  <text
                    key={m.label}
                    x={p.x}
                    y={HEIGHT - 8}
                    textAnchor="middle"
                    fontSize={11}
                    fill="rgba(255,255,255,0.55)"
                  >
                    {m.label}
                  </text>
                )
              })}

              {/* AWS actual line (muted) */}
              <motion.polyline
                points={pointsToStr(awsPoints)}
                fill="none"
                stroke="rgba(255,255,255,0.5)"
                strokeWidth={2}
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
              />
              {awsPoints.map((p, i) =>
                p ? <circle key={`aws-${i}`} cx={p.x} cy={p.y} r={hoverIdx === i ? 5 : 3} fill="rgba(255,255,255,0.6)" /> : null,
              )}

              {/* Old retail rate line (dashed, neutral) */}
              <motion.polyline
                points={pointsToStr(oldRetailPoints)}
                fill="none"
                stroke={theme.palette.grey[500]}
                strokeWidth={2}
                strokeDasharray="5 4"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.6, ease: 'easeOut', delay: 0.1 }}
              />
              {oldRetailPoints.map((p, i) =>
                p ? <circle key={`old-${i}`} cx={p.x} cy={p.y} r={hoverIdx === i ? 5 : 3} fill={theme.palette.grey[500]} /> : null,
              )}

              {/* New retail rate line (brand orange) */}
              <motion.polyline
                points={pointsToStr(newRetailPoints)}
                fill="none"
                stroke={theme.palette.primary.main}
                strokeWidth={2.5}
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.6, ease: 'easeOut', delay: 0.2 }}
              />
              {newRetailPoints.map((p, i) =>
                p ? <circle key={`new-${i}`} cx={p.x} cy={p.y} r={hoverIdx === i ? 5 : 3} fill={theme.palette.primary.main} /> : null,
              )}

              {/* Hover guide line */}
              {hoverAwsPoint && (
                <line
                  x1={hoverAwsPoint.x}
                  x2={hoverAwsPoint.x}
                  y1={PADDING.top}
                  y2={PADDING.top + CHART_H}
                  stroke="rgba(255,255,255,0.25)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
              )}

              {/* Invisible hover-capture overlay */}
              <rect
                x={PADDING.left}
                y={PADDING.top}
                width={CHART_W}
                height={CHART_H}
                fill="transparent"
                onMouseMove={handleMouseMove}
                onMouseLeave={() => setHoverIdx(null)}
              />
            </svg>

            {hoverMonth && hoverAwsPoint && (
              <Box
                sx={{
                  position: 'absolute',
                  left: `${Math.min(Math.max((hoverAwsPoint.x / WIDTH) * 100, 12), 88)}%`,
                  top: 8,
                  transform: 'translateX(-50%)',
                  bgcolor: 'background.paper',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 1.5,
                  px: 1.5,
                  py: 1,
                  pointerEvents: 'none',
                  boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
                  minWidth: 170,
                }}
              >
                <Typography variant="caption" fontWeight={700} sx={{ display: 'block', mb: 0.5 }}>
                  {hoverMonth.label}
                </Typography>
                <Typography variant="caption" sx={{ display: 'block', color: 'rgba(255,255,255,0.7)', fontVariantNumeric: 'tabular-nums' }}>
                  AWS actual: {formatUSD(hoverMonth.awsTotal)}
                </Typography>
                <Typography variant="caption" sx={{ display: 'block', color: theme.palette.grey[400], fontVariantNumeric: 'tabular-nums' }}>
                  Billed rate (frozen): {hoverMonth.runtimeRetailOld !== null ? formatUSD(hoverMonth.runtimeRetailOld) : 'n/a'}
                </Typography>
                <Typography variant="caption" sx={{ display: 'block', color: theme.palette.primary.main, fontVariantNumeric: 'tabular-nums' }}>
                  Effective rate{hoverRate ? ` ($${Number(hoverRate.retailRate).toFixed(3)})` : ''}: {hoverProjected !== null ? formatUSD(hoverProjected) : 'n/a'}
                </Typography>
                {hoverMonth.runtimeCcuHours !== null && (
                  <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                    {hoverMonth.runtimeCcuHours.toLocaleString()} CCU-hrs
                  </Typography>
                )}
              </Box>
            )}
          </Box>
        </CardContent>
      </Card>
    </motion.div>
  )
}

export default HistoricalRateChart
