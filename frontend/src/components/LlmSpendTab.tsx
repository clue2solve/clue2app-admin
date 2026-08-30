import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material'
import { motion } from 'framer-motion'
import SmartToyIcon from '@mui/icons-material/SmartToy'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import CloudDownloadIcon from '@mui/icons-material/CloudDownload'
import { coordinatorGet, COORDINATOR_BASE_URL, getToken } from '../api'

/**
 * SCK-632 — SYSTEM-only LLM spend admin dashboard.
 *
 * Renders three panels:
 *   • Top-N accounts by spend (with CSV export button).
 *   • Top-N routes by spend across ALL accounts.
 *   • Anomaly flags — accounts whose current-month daily rate is
 *     ≥ 3× last month's daily rate.
 *
 * Every request is a SYSTEM-guarded coord endpoint under
 * /api/admin/llm-spend/*; the 403 that comes back for a non-SYSTEM
 * caller is surfaced as a red alert (rather than a silent empty
 * dashboard).
 */

interface AdminRow {
  key: string
  label: string
  promptTokens: number
  completionTokens: number
  costUsd: number
  requestCount: number
}

interface Anomaly {
  accountId: string
  accountName: string
  baselineDailyUsd: number
  currentDailyUsd: number
  multiplier: number
  currentMonthTotalUsd: number
}

interface AnomaliesResponse {
  anomalies: Anomaly[]
  source: string
}

const RANGE_OPTIONS = [
  { id: '7d', label: '7d', days: 7 },
  { id: '30d', label: '30d', days: 30 },
  { id: '90d', label: '90d', days: 90 },
  { id: 'custom', label: 'Custom', days: null },
] as const

type RangeId = (typeof RANGE_OPTIONS)[number]['id']

const formatDollars = (n: number | null | undefined): string => {
  if (n == null || Number.isNaN(n)) return '$0.00'
  if (!Number.isFinite(n)) return '∞'
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
}

const formatMultiplier = (n: number): string => {
  if (!Number.isFinite(n)) return 'new usage'
  return `${n.toFixed(1)}×`
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10)

const rangeToInstants = (
  rangeId: RangeId,
  customStart: string,
  customEnd: string
): { start: Date | null; end: Date | null } => {
  const now = new Date()
  if (rangeId === 'custom') {
    const start = customStart ? new Date(customStart) : null
    const end = customEnd ? new Date(customEnd) : null
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
      return { start: null, end: null }
    }
    return { start, end }
  }
  const opt = RANGE_OPTIONS.find((o) => o.id === rangeId) || RANGE_OPTIONS[1]
  const days = opt.days || 30
  const start = new Date(now.getTime() - days * 86400000)
  return { start, end: now }
}

const buildRangeQuery = (start: Date | null, end: Date | null, extra: Record<string, string> = {}) => {
  const params = new URLSearchParams(extra)
  if (start) params.set('rangeStart', start.toISOString())
  if (end) params.set('rangeEnd', end.toISOString())
  return params.toString()
}

const TopNTable = ({
  title,
  rows,
  keyColHeader,
  testId,
  action,
}: {
  title: string
  rows: AdminRow[]
  keyColHeader: string
  testId: string
  action?: React.ReactNode
}) => (
  <Paper variant="outlined" sx={{ mt: 2 }} data-testid={testId}>
    <Box sx={{ p: 2, pb: 0, display: 'flex', alignItems: 'center', gap: 1 }}>
      <Typography variant="subtitle1" fontWeight={600} sx={{ flexGrow: 1 }}>
        {title}
      </Typography>
      {action}
    </Box>
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>{keyColHeader}</TableCell>
            <TableCell align="right">Prompt tokens</TableCell>
            <TableCell align="right">Completion tokens</TableCell>
            <TableCell align="right">Requests</TableCell>
            <TableCell align="right">Cost (USD)</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                No usage captured for this window yet.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.key} hover>
                <TableCell>
                  <Tooltip title={r.key}>
                    <span>{r.label || r.key}</span>
                  </Tooltip>
                </TableCell>
                <TableCell align="right">{r.promptTokens.toLocaleString()}</TableCell>
                <TableCell align="right">{r.completionTokens.toLocaleString()}</TableCell>
                <TableCell align="right">{r.requestCount.toLocaleString()}</TableCell>
                <TableCell align="right">{formatDollars(r.costUsd)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </TableContainer>
  </Paper>
)

const AnomalyTable = ({ anomalies }: { anomalies: Anomaly[] }) => (
  <Paper variant="outlined" sx={{ mt: 2 }} data-testid="anomalies-table">
    <Box sx={{ p: 2, pb: 0, display: 'flex', alignItems: 'center', gap: 1 }}>
      <WarningAmberIcon color="warning" fontSize="small" />
      <Typography variant="subtitle1" fontWeight={600}>
        Anomaly flags (current daily rate vs previous whole month)
      </Typography>
    </Box>
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Account</TableCell>
            <TableCell align="right">Baseline $/day</TableCell>
            <TableCell align="right">Current $/day</TableCell>
            <TableCell align="right">Multiplier</TableCell>
            <TableCell align="right">MTD total</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {anomalies.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                No anomalies over the current threshold.
              </TableCell>
            </TableRow>
          ) : (
            anomalies.map((a) => (
              <TableRow key={a.accountId} hover>
                <TableCell>
                  <Tooltip title={a.accountId}>
                    <span>{a.accountName || a.accountId}</span>
                  </Tooltip>
                </TableCell>
                <TableCell align="right">{formatDollars(a.baselineDailyUsd)}</TableCell>
                <TableCell align="right">{formatDollars(a.currentDailyUsd)}</TableCell>
                <TableCell align="right">
                  <Chip
                    size="small"
                    color={Number.isFinite(a.multiplier) ? 'warning' : 'error'}
                    label={formatMultiplier(a.multiplier)}
                    data-testid={`anomaly-multiplier-${a.accountId}`}
                  />
                </TableCell>
                <TableCell align="right">{formatDollars(a.currentMonthTotalUsd)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </TableContainer>
  </Paper>
)

// Trigger a browser download for a coord CSV endpoint. Uses fetch +
// Blob so the Authorization header rides along; a plain <a href> to
// the coord URL would strip the bearer token.
async function downloadCsv(path: string, filename: string): Promise<void> {
  const token = getToken()
  const headers = new Headers()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(`${COORDINATOR_BASE_URL}${path}`, { method: 'GET', headers })
  if (!res.ok) throw new Error(`CSV export failed (HTTP ${res.status})`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Revoke on the next tick so Safari finishes the download before
  // the object URL becomes unreachable.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

const DEFAULT_LIMIT = 10

export default function LlmSpendTab(): JSX.Element {
  const [rangeId, setRangeId] = useState<RangeId>('30d')
  const [customStart, setCustomStart] = useState<string>(
    isoDay(new Date(Date.now() - 30 * 86400000))
  )
  const [customEnd, setCustomEnd] = useState<string>(isoDay(new Date()))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [topAccounts, setTopAccounts] = useState<AdminRow[]>([])
  const [topRoutes, setTopRoutes] = useState<AdminRow[]>([])
  const [anomalies, setAnomalies] = useState<Anomaly[]>([])
  const [source, setSource] = useState<string>('stub')
  const [csvBusy, setCsvBusy] = useState(false)
  const [csvError, setCsvError] = useState<string | null>(null)

  const { start, end } = useMemo(
    () => rangeToInstants(rangeId, customStart, customEnd),
    [rangeId, customStart, customEnd]
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rangeQuery = buildRangeQuery(start, end, { limit: String(DEFAULT_LIMIT) })
      const [accounts, routes, anomaliesResp] = await Promise.all([
        coordinatorGet<AdminRow[]>(`/api/admin/llm-spend/top-accounts?${rangeQuery}`),
        coordinatorGet<AdminRow[]>(`/api/admin/llm-spend/top-routes?${rangeQuery}`),
        coordinatorGet<AnomaliesResponse>(
          `/api/admin/llm-spend/anomalies?limit=${DEFAULT_LIMIT}`
        ),
      ])
      setTopAccounts(accounts || [])
      setTopRoutes(routes || [])
      setAnomalies(anomaliesResp?.anomalies || [])
      setSource(anomaliesResp?.source || 'stub')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg || 'Failed to load LLM spend')
    } finally {
      setLoading(false)
    }
  }, [start, end])

  useEffect(() => {
    if (!start || !end) {
      setLoading(false)
      setError('Custom range: end must be after start')
      setTopAccounts([])
      setTopRoutes([])
      setAnomalies([])
      return
    }
    void load()
  }, [load, start, end])

  const totalSpendInWindow = topAccounts.reduce((acc, r) => acc + (r.costUsd || 0), 0)

  const handleExportCsv = async () => {
    setCsvBusy(true)
    setCsvError(null)
    try {
      const rangeQuery = buildRangeQuery(start, end, { limit: String(DEFAULT_LIMIT) })
      await downloadCsv(
        `/api/admin/llm-spend/export.csv?${rangeQuery}`,
        `llm-spend-top-accounts-${isoDay(new Date())}.csv`
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setCsvError(msg || 'CSV export failed')
    } finally {
      setCsvBusy(false)
    }
  }

  return (
    <Box
      component={motion.div}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      data-testid="llm-spend-tab"
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
        <SmartToyIcon color="primary" />
        <Typography variant="h5" fontWeight={600}>
          LLM Spend (SYSTEM)
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        <Chip
          size="small"
          data-testid="source-chip"
          label={`source: ${source}`}
          color={source === 'stub' ? 'default' : 'primary'}
        />
      </Box>

      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardContent>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            alignItems={{ xs: 'stretch', sm: 'center' }}
          >
            <ToggleButtonGroup
              value={rangeId}
              exclusive
              size="small"
              onChange={(_, v) => v && setRangeId(v)}
              data-testid="range-picker"
            >
              {RANGE_OPTIONS.map((opt) => (
                <ToggleButton key={opt.id} value={opt.id} data-testid={`range-${opt.id}`}>
                  {opt.label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            {rangeId === 'custom' && (
              <>
                <TextField
                  type="date"
                  size="small"
                  label="Start"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                  InputLabelProps={{ shrink: true }}
                  data-testid="range-custom-start"
                />
                <TextField
                  type="date"
                  size="small"
                  label="End"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  InputLabelProps={{ shrink: true }}
                  data-testid="range-custom-end"
                />
              </>
            )}
            <Box sx={{ flexGrow: 1 }} />
            <Typography variant="body2" color="text.secondary">
              Sum of top {DEFAULT_LIMIT} accounts in window:{' '}
              <strong>{formatDollars(totalSpendInWindow)}</strong>
            </Typography>
          </Stack>
        </CardContent>
      </Card>

      {source === 'stub' && (
        <Alert severity="info" sx={{ mb: 2 }} data-testid="stub-banner">
          Coord's LLM-spend source is still the stub — every panel below will
          light up as soon as the platform gateway starts emitting per-request
          metrics.
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
          <CircularProgress data-testid="llm-spend-loading" />
        </Box>
      ) : error ? (
        <Alert severity="error" data-testid="llm-spend-error">
          {error}
        </Alert>
      ) : (
        <>
          <TopNTable
            title={`Top ${DEFAULT_LIMIT} accounts by spend`}
            rows={topAccounts}
            keyColHeader="Account"
            testId="top-accounts-table"
            action={
              <Button
                size="small"
                variant="outlined"
                startIcon={<CloudDownloadIcon />}
                onClick={handleExportCsv}
                disabled={csvBusy}
                data-testid="csv-export-btn"
              >
                {csvBusy ? 'Exporting…' : 'Export CSV'}
              </Button>
            }
          />
          {csvError && (
            <Alert severity="error" sx={{ mt: 1 }} data-testid="csv-error">
              {csvError}
            </Alert>
          )}

          <TopNTable
            title={`Top ${DEFAULT_LIMIT} routes by spend`}
            rows={topRoutes}
            keyColHeader="Route (provider:model)"
            testId="top-routes-table"
          />

          <Divider sx={{ my: 3 }} />
          <AnomalyTable anomalies={anomalies} />
        </>
      )}
    </Box>
  )
}
