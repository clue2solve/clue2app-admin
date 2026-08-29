import { useEffect, useState } from 'react'
import {
  Box,
  Card,
  CardContent,
  Typography,
  Grid,
  CircularProgress,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Chip,
  Tooltip,
} from '@mui/material'
import { motion } from 'framer-motion'
import AttachMoneyIcon from '@mui/icons-material/AttachMoney'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import TrendingDownIcon from '@mui/icons-material/TrendingDown'
import TrendingFlatIcon from '@mui/icons-material/TrendingFlat'
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth'
import CalendarTodayIcon from '@mui/icons-material/CalendarToday'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  ReferenceDot,
} from 'recharts'
import { apiGet } from '../api'

// --- API types ---------------------------------------------------------------

interface Period {
  start: string
  end: string
}

interface SummaryResponse {
  currency: string
  mtd: Period & { cost: number }
  previous_month: Period & { cost: number }
  previous_month_to_date: Period & { cost: number; note?: string }
  delta_pct: number | null
  delta_pct_basis: string
  generated_at: string
}

interface ServiceRow {
  service: string
  cost: number
  pct_of_total: number
}

interface ByServiceResponse {
  currency: string
  period: Period
  total: number
  services: ServiceRow[]
  generated_at: string
}

interface HistoricalPoint {
  date: string
  cost: number
}

interface HistoricalResponse {
  currency: string
  granularity: string
  series: HistoricalPoint[]
  generated_at: string
}

interface ResourceRow {
  resource_id: string
  service: string
  cost: number
  tags: Record<string, string>
}

interface TopResourcesResponse {
  currency?: string
  period?: Period
  total_resources_reported?: number
  resources: ResourceRow[]
  generated_at?: string
  // Backend returns this when the payer account has NOT opted in to
  // resource-level CE data. UI renders a friendly enable-in-AWS panel
  // instead of a red banner. See admin backend costs_top_resources.
  resourceLevelEnabled?: boolean
  message?: string
  helpUrl?: string
}

// --- helpers -----------------------------------------------------------------

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.1 },
  },
}

const item = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0 },
}

function formatUSD(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return '—'
  // Coerce: some cost endpoints stringify decimals to avoid float
  // truncation. Number("12.5") is 12.5, Number("") is 0, Number("abc")
  // is NaN — the isFinite guard covers the last case.
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) return '—'
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function formatMonthYear(iso: string): string {
  // iso: "2026-02-01"
  const d = new Date(iso + 'T00:00:00Z')
  return d.toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
}

function formatDateRange(p: Period): string {
  return `${p.start} → ${p.end}`
}

function formatGeneratedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

// --- component ---------------------------------------------------------------

function PlatformCostTab() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null)
  const [byService, setByService] = useState<ByServiceResponse | null>(null)
  const [historical, setHistorical] = useState<HistoricalResponse | null>(null)
  const [topResources, setTopResources] = useState<TopResourcesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const [s, bs, h, tr] = await Promise.all([
          apiGet<SummaryResponse>('/api/costs/summary'),
          apiGet<ByServiceResponse>('/api/costs/by-service?months=1'),
          apiGet<HistoricalResponse>('/api/costs/historical?months=6'),
          apiGet<TopResourcesResponse>('/api/costs/top-resources?days=14&limit=20'),
        ])
        if (cancelled) return
        setSummary(s)
        setByService(bs)
        setHistorical(h)
        setTopResources(tr)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load cost data')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 10 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (error) {
    return <Alert severity="error">{error}</Alert>
  }

  const delta = summary?.delta_pct ?? null
  const deltaDirection: 'up' | 'down' | 'flat' | 'unknown' =
    delta === null
      ? 'unknown'
      : Math.abs(delta) < 0.005
        ? 'flat'
        : delta > 0
          ? 'up'
          : 'down'
  const deltaColor =
    deltaDirection === 'up'
      ? 'error.main'
      : deltaDirection === 'down'
        ? 'success.main'
        : 'text.secondary'
  const DeltaIcon =
    deltaDirection === 'up'
      ? TrendingUpIcon
      : deltaDirection === 'down'
        ? TrendingDownIcon
        : TrendingFlatIcon

  const historicalSeries = (historical?.series || []).map((p) => ({
    date: p.date,
    label: formatMonthYear(p.date),
    cost: p.cost,
  }))
  const lastPointIndex = historicalSeries.length - 1

  return (
    <motion.div variants={container} initial="hidden" animate="show">
      {/* --- Hero row: 3 stat cards ------------------------------------ */}
      <Grid container spacing={3} sx={{ mb: 3 }}>
        <Grid item xs={12} md={4}>
          <motion.div variants={item}>
            <Card sx={{ height: '100%' }}>
              <CardContent>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                  <CalendarTodayIcon color="primary" />
                  <Typography variant="subtitle2" color="text.secondary" fontWeight={600}>
                    This Month (MTD)
                  </Typography>
                </Box>
                <Typography variant="h4" fontWeight={700}>
                  {formatUSD(summary?.mtd.cost)}
                </Typography>
                {summary && (
                  <Typography variant="caption" color="text.secondary">
                    {formatDateRange(summary.mtd)}
                  </Typography>
                )}
              </CardContent>
            </Card>
          </motion.div>
        </Grid>

        <Grid item xs={12} md={4}>
          <motion.div variants={item}>
            <Card sx={{ height: '100%' }}>
              <CardContent>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                  <CalendarMonthIcon color="primary" />
                  <Typography variant="subtitle2" color="text.secondary" fontWeight={600}>
                    Last Month (Total)
                  </Typography>
                </Box>
                <Typography variant="h4" fontWeight={700}>
                  {formatUSD(summary?.previous_month.cost)}
                </Typography>
                {summary && (
                  <Typography variant="caption" color="text.secondary">
                    {formatDateRange(summary.previous_month)}
                  </Typography>
                )}
              </CardContent>
            </Card>
          </motion.div>
        </Grid>

        <Grid item xs={12} md={4}>
          <motion.div variants={item}>
            <Card sx={{ height: '100%' }}>
              <CardContent>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                  <DeltaIcon sx={{ color: deltaColor }} />
                  <Typography variant="subtitle2" color="text.secondary" fontWeight={600}>
                    Δ vs Same Day Last Month
                  </Typography>
                </Box>
                <Typography variant="h4" fontWeight={700} sx={{ color: deltaColor }}>
                  {delta === null
                    ? '—'
                    : `${delta > 0 ? '+' : ''}${Number(delta ?? 0).toFixed(2)}%`}
                </Typography>
                {summary && (
                  <Tooltip title={summary.previous_month_to_date.note || ''}>
                    <Typography variant="caption" color="text.secondary">
                      vs {formatUSD(summary.previous_month_to_date.cost)} through{' '}
                      {summary.previous_month_to_date.end}
                    </Typography>
                  </Tooltip>
                )}
              </CardContent>
            </Card>
          </motion.div>
        </Grid>
      </Grid>

      {/* --- Historical trend chart ------------------------------------ */}
      <motion.div variants={item}>
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
              <AttachMoneyIcon color="primary" />
              <Typography variant="h6" fontWeight={600}>
                6-Month Cost Trend
              </Typography>
              {historical && (
                <Chip
                  size="small"
                  variant="outlined"
                  label={`as of ${formatGeneratedAt(historical.generated_at)}`}
                  sx={{ ml: 'auto' }}
                />
              )}
            </Box>
            <Box sx={{ width: '100%', height: 320 }}>
              <ResponsiveContainer>
                <LineChart
                  data={historicalSeries}
                  margin={{ top: 10, right: 30, left: 10, bottom: 10 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                  <XAxis dataKey="label" />
                  <YAxis
                    tickFormatter={(v: number) =>
                      (() => {
                        const n = Number(v ?? 0)
                        if (!Number.isFinite(n)) return '$0'
                        return n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`
                      })()
                    }
                  />
                  <RechartsTooltip
                    formatter={(v: number) => formatUSD(v)}
                    labelFormatter={(label) => `Month: ${label}`}
                  />
                  <Line
                    type="monotone"
                    dataKey="cost"
                    stroke="#FF9900"
                    strokeWidth={3}
                    dot={{ r: 5, fill: '#FF9900' }}
                    activeDot={{ r: 7 }}
                  />
                  {lastPointIndex >= 0 && historicalSeries[lastPointIndex] && (
                    <ReferenceDot
                      x={historicalSeries[lastPointIndex].label}
                      y={historicalSeries[lastPointIndex].cost}
                      r={7}
                      fill="#232F3E"
                      stroke="#FF9900"
                      strokeWidth={2}
                      label={{
                        value: 'MTD',
                        position: 'top',
                        fill: '#232F3E',
                        fontSize: 12,
                        fontWeight: 700,
                      }}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </Box>
          </CardContent>
        </Card>
      </motion.div>

      {/* --- Cost by service ------------------------------------------- */}
      <motion.div variants={item}>
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
              <Typography variant="h6" fontWeight={600}>
                Cost by Service
              </Typography>
              {byService && (
                <Chip
                  size="small"
                  variant="outlined"
                  label={`${formatDateRange(byService.period)} · total ${formatUSD(byService.total)}`}
                  sx={{ ml: 'auto' }}
                />
              )}
            </Box>
            <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 480 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>Service</TableCell>
                    <TableCell align="right">Cost</TableCell>
                    <TableCell align="right">% of Total</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(byService?.services || []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} align="center">
                        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                          No service cost data for this period.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                  {(byService?.services || []).map((s) => (
                    <TableRow key={s.service} hover>
                      <TableCell>{s.service}</TableCell>
                      <TableCell align="right">{formatUSD(s.cost)}</TableCell>
                      <TableCell align="right">
                        <Box
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'flex-end',
                            gap: 1,
                          }}
                        >
                          <Box
                            sx={{
                              width: 60,
                              height: 6,
                              borderRadius: 3,
                              bgcolor: '#eee',
                              overflow: 'hidden',
                            }}
                          >
                            <Box
                              sx={{
                                width: `${Math.min(100, Number(s.pct_of_total ?? 0))}%`,
                                height: '100%',
                                bgcolor: 'secondary.main',
                              }}
                            />
                          </Box>
                          <Typography variant="body2">
                            {Number(s.pct_of_total ?? 0).toFixed(2)}%
                          </Typography>
                        </Box>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </CardContent>
        </Card>
      </motion.div>

      {/* --- Top resources --------------------------------------------- */}
      <motion.div variants={item}>
        <Card>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
              <Typography variant="h6" fontWeight={600}>
                Top {topResources?.total_resources_reported ?? 20} Most Expensive Resources
              </Typography>
              {topResources?.period && (
                <Chip
                  size="small"
                  variant="outlined"
                  label={formatDateRange(topResources.period)}
                  sx={{ ml: 'auto' }}
                />
              )}
            </Box>

            {topResources?.resourceLevelEnabled === false && (
              <Box
                sx={{
                  p: 2.5,
                  mb: 2,
                  borderRadius: 1,
                  border: 1,
                  borderColor: 'warning.main',
                  bgcolor: 'action.hover',
                }}
              >
                <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 0.5 }}>
                  Resource-level Cost Explorer not enabled
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  {topResources.message ??
                    'This AWS account has not opted in to resource-level CE data. Enable it in the payer accounts Billing → Cost Explorer → Preferences.'}
                </Typography>
                {topResources.helpUrl && (
                  <Typography variant="body2">
                    <a
                      href={topResources.helpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'inherit' }}
                    >
                      Open AWS Cost Explorer Settings →
                    </a>
                  </Typography>
                )}
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  Data starts populating within ~24 hours after enable. History is not backfilled.
                </Typography>
              </Box>
            )}

            <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 560 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>Resource ID</TableCell>
                    <TableCell>Service</TableCell>
                    <TableCell align="right">Cost</TableCell>
                    <TableCell>Tags</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(topResources?.resources || []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} align="center">
                        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                          No resource-level cost data for this period.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                  {(topResources?.resources || []).map((r) => {
                    const nameTag = r.tags?.Name
                    const tagEntries = Object.entries(r.tags || {})
                    return (
                      <TableRow key={r.resource_id} hover>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.85em' }}>
                          <Tooltip title={r.resource_id}>
                            <Box
                              sx={{
                                maxWidth: 260,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {nameTag ? (
                                <>
                                  <Typography variant="body2" fontWeight={600} noWrap>
                                    {nameTag}
                                  </Typography>
                                  <Typography
                                    variant="caption"
                                    color="text.secondary"
                                    noWrap
                                    sx={{ display: 'block' }}
                                  >
                                    {r.resource_id}
                                  </Typography>
                                </>
                              ) : (
                                r.resource_id
                              )}
                            </Box>
                          </Tooltip>
                        </TableCell>
                        <TableCell>{r.service}</TableCell>
                        <TableCell align="right">{formatUSD(r.cost)}</TableCell>
                        <TableCell>
                          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, maxWidth: 360 }}>
                            {tagEntries.length === 0 && (
                              <Typography variant="caption" color="text.secondary">
                                (no tags)
                              </Typography>
                            )}
                            {tagEntries.slice(0, 4).map(([k, v]) => (
                              <Chip
                                key={k}
                                size="small"
                                variant="outlined"
                                label={`${k}=${v}`}
                                sx={{ fontSize: '0.7rem' }}
                              />
                            ))}
                            {tagEntries.length > 4 && (
                              <Chip
                                size="small"
                                label={`+${tagEntries.length - 4} more`}
                                sx={{ fontSize: '0.7rem' }}
                              />
                            )}
                          </Box>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          </CardContent>
        </Card>
      </motion.div>

      {summary && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 2, textAlign: 'right' }}
        >
          Data as of {formatGeneratedAt(summary.generated_at)} · Cost Explorer lags ~24h
        </Typography>
      )}
    </motion.div>
  )
}

export default PlatformCostTab
