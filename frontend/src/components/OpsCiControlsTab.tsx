import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Link,
  Paper,
  Skeleton,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material'
import { motion } from 'framer-motion'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import BuildCircleIcon from '@mui/icons-material/BuildCircle'
import RefreshIcon from '@mui/icons-material/Refresh'
import { apiFetch, apiGet, ApiError } from '../api'

// -----------------------------------------------------------------------------
// SYSTEM-only page. On-demand verification workflows the operator can fire
// (starting with "verify a fresh PyPI install still works"). Rows come from
// GET /api/ops/ci-triggers (allowlist + last workflow_dispatch run per row).
// Click Run → confirm dialog → POST /api/ops/ci-triggers/{id}/run → toast +
// row refreshes. While any row's status is queued/in_progress we poll every
// 15s so the outcome shows up without a manual refresh.
// -----------------------------------------------------------------------------

interface LastRun {
  run_id: number | null
  run_number: number | null
  status: string | null // queued | in_progress | completed
  conclusion: string | null // success | failure | cancelled | timed_out | ...
  html_url: string | null
  created_at: string | null
  updated_at: string | null
  actor: string | null
  event: string | null
}

interface CiTriggerRow {
  id: string
  name: string
  description: string
  target_repo: string
  workflow_filename: string
  ref: string
  last_run: LastRun | null
}

interface ListResponse {
  triggers: CiTriggerRow[]
  gh_token_configured: boolean
}

const POLL_MS = 15_000

function formatRelative(iso: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const deltaSec = Math.max(1, Math.round((Date.now() - then) / 1000))
  if (deltaSec < 60) return `${deltaSec}s ago`
  const min = Math.round(deltaSec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 48) return `${hr}h ago`
  const days = Math.round(hr / 24)
  return `${days}d ago`
}

type PillTone = 'success' | 'error' | 'warning' | 'info' | 'default'

function statusPill(run: LastRun | null): { label: string; tone: PillTone } {
  if (!run || (!run.status && !run.conclusion)) return { label: 'no runs yet', tone: 'default' }
  if (run.status === 'queued') return { label: 'queued', tone: 'info' }
  if (run.status === 'in_progress') return { label: 'running', tone: 'info' }
  if (run.status === 'completed') {
    switch (run.conclusion) {
      case 'success':
        return { label: 'success', tone: 'success' }
      case 'failure':
        return { label: 'failed', tone: 'error' }
      case 'cancelled':
        return { label: 'cancelled', tone: 'warning' }
      case 'timed_out':
        return { label: 'timed out', tone: 'error' }
      case 'skipped':
        return { label: 'skipped', tone: 'default' }
      case 'action_required':
        return { label: 'action required', tone: 'warning' }
      default:
        return { label: run.conclusion ?? 'done', tone: 'default' }
    }
  }
  return { label: run.status ?? 'unknown', tone: 'default' }
}

export default function OpsCiControlsTab(): JSX.Element {
  const [rows, setRows] = useState<CiTriggerRow[] | null>(null)
  const [tokenConfigured, setTokenConfigured] = useState<boolean>(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [confirmRow, setConfirmRow] = useState<CiTriggerRow | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [snack, setSnack] = useState<{
    open: boolean
    message: string
    severity: 'success' | 'error'
    href?: string
  }>({ open: false, message: '', severity: 'success' })

  const pollTimerRef = useRef<number | null>(null)

  const load = useCallback(async () => {
    try {
      const body = await apiGet<ListResponse>('/api/ops/ci-triggers')
      setRows(body.triggers)
      setTokenConfigured(body.gh_token_configured)
      setLoadError(null)
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message
      setLoadError(msg || 'Failed to load CI triggers')
      // Still render the shell — an empty rows array shows EmptyState,
      // but here we keep any prior rows so a transient error doesn't
      // wipe the table.
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // While anything is queued or in_progress, poll for updates.
  const shouldPoll = useMemo(() => {
    if (!rows) return false
    return rows.some(
      (r) =>
        r.last_run?.status === 'queued' || r.last_run?.status === 'in_progress',
    )
  }, [rows])

  useEffect(() => {
    if (!shouldPoll) {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
      return
    }
    const id = window.setInterval(() => {
      load()
    }, POLL_MS)
    pollTimerRef.current = id
    return () => {
      window.clearInterval(id)
      pollTimerRef.current = null
    }
  }, [shouldPoll, load])

  const doRun = useCallback(
    async (row: CiTriggerRow) => {
      setRunningId(row.id)
      try {
        const resp = await apiFetch(
          `/api/ops/ci-triggers/${encodeURIComponent(row.id)}/run`,
          { method: 'POST' },
        )
        if (!resp.ok) {
          let detail = `Dispatch failed (${resp.status})`
          try {
            const body = (await resp.json()) as { detail?: string; message?: string }
            detail = body.detail || body.message || detail
          } catch {
            /* ignore */
          }
          setSnack({ open: true, message: detail, severity: 'error' })
          return
        }
        const body = (await resp.json()) as { last_run: LastRun | null }
        setSnack({
          open: true,
          message: `Dispatched "${row.name}"`,
          severity: 'success',
          href: body.last_run?.html_url ?? undefined,
        })
        await load()
      } catch (e) {
        setSnack({
          open: true,
          message: (e as Error).message || 'Dispatch failed',
          severity: 'error',
        })
      } finally {
        setRunningId(null)
        setConfirmRow(null)
      }
    },
    [load],
  )

  const isLoading = rows === null && loadError === null
  const isEmpty = rows !== null && rows.length === 0

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
    >
      <Box sx={{ p: 3, maxWidth: 1200, mx: 'auto' }}>
        {/* PageHeader */}
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 0.5 }}>
          <BuildCircleIcon color="primary" />
          <Typography variant="h6" fontWeight={600}>
            Ops Controls · CI Triggers
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          <Tooltip title="Refresh">
            <IconButton
              size="small"
              aria-label="refresh CI triggers"
              onClick={() => load()}
            >
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          On-demand verification workflows the operator can fire outside cron.
          Every entry is server-side allowlisted — the button never dispatches
          a workflow that isn't in this list.
        </Typography>

        {loadError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {loadError}
          </Alert>
        )}

        {!tokenConfigured && rows !== null && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            <strong>GH_OPS_DISPATCH_TOKEN not configured</strong> on this admin
            instance. Rows render but the Run button will 503 until an operator
            mints a fine-scoped PAT with <code>actions:write</code> on the
            target repos and mounts it on the admin ksvc.
          </Alert>
        )}

        <TableContainer component={Paper} variant="outlined">
          <Table size="small" sx={{ '& .actions-cell': { width: 120 } }}>
            <TableHead>
              <TableRow>
                <TableCell>What it verifies</TableCell>
                <TableCell>Target</TableCell>
                <TableCell>Last run</TableCell>
                <TableCell className="actions-cell" align="right">
                  Actions
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading &&
                [0, 1, 2].map((i) => (
                  <TableRow key={`sk-${i}`}>
                    <TableCell>
                      <Skeleton width="60%" />
                      <Skeleton width="90%" />
                    </TableCell>
                    <TableCell>
                      <Skeleton width="80%" />
                    </TableCell>
                    <TableCell>
                      <Skeleton width={80} />
                    </TableCell>
                    <TableCell align="right">
                      <Skeleton width={64} sx={{ ml: 'auto' }} />
                    </TableCell>
                  </TableRow>
                ))}

              {isEmpty && (
                <TableRow>
                  <TableCell colSpan={4} sx={{ py: 6, border: 0 }}>
                    <Stack alignItems="center" spacing={1}>
                      <BuildCircleIcon color="disabled" sx={{ fontSize: 48 }} />
                      <Typography variant="subtitle1" fontWeight={600}>
                        No CI triggers configured
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        Add an entry to <code>CI_TRIGGERS_ALLOWLIST</code> in
                        the admin backend to expose a new on-demand workflow.
                      </Typography>
                    </Stack>
                  </TableCell>
                </TableRow>
              )}

              {rows?.map((row) => {
                const pill = statusPill(row.last_run)
                return (
                  <TableRow
                    key={row.id}
                    hover
                    sx={{
                      '&:hover .row-actions': { opacity: 1 },
                    }}
                  >
                    <TableCell>
                      <Typography variant="body2" fontWeight={600}>
                        {row.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {row.description}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontFamily="monospace">
                        {row.target_repo}
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        fontFamily="monospace"
                      >
                        {row.workflow_filename} @ {row.ref}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" alignItems="center" spacing={1}>
                        <Chip
                          size="small"
                          label={pill.label}
                          color={pill.tone === 'default' ? undefined : pill.tone}
                          variant={pill.tone === 'default' ? 'outlined' : 'filled'}
                        />
                        <Typography variant="caption" color="text.secondary">
                          {formatRelative(
                            row.last_run?.updated_at || row.last_run?.created_at || null,
                          )}
                        </Typography>
                      </Stack>
                      {row.last_run?.actor && (
                        <Typography variant="caption" color="text.secondary">
                          by {row.last_run.actor}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right" className="actions-cell">
                      <Stack
                        direction="row"
                        spacing={0.5}
                        justifyContent="flex-end"
                        alignItems="center"
                        className="row-actions"
                        sx={{
                          opacity: 0.35,
                          transition: 'opacity 120ms ease',
                        }}
                      >
                        {row.last_run?.html_url && (
                          <Tooltip title="View last run in GitHub">
                            <IconButton
                              size="small"
                              aria-label={`view last run for ${row.name} on GitHub`}
                              component="a"
                              href={row.last_run.html_url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <OpenInNewIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                        <Button
                          size="small"
                          variant="contained"
                          startIcon={<PlayArrowIcon />}
                          disabled={runningId === row.id}
                          onClick={() => setConfirmRow(row)}
                        >
                          Run
                        </Button>
                      </Stack>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </TableContainer>

        {/* Confirmation dialog */}
        <Dialog
          open={confirmRow !== null}
          onClose={() => (runningId === null ? setConfirmRow(null) : null)}
          maxWidth="sm"
          fullWidth
        >
          <DialogTitle>Run {confirmRow?.name}?</DialogTitle>
          <DialogContent>
            <DialogContentText>
              This will trigger a workflow run on{' '}
              <code>{confirmRow?.target_repo}</code> using{' '}
              <code>{confirmRow?.workflow_filename}</code> on{' '}
              <code>{confirmRow?.ref}</code>. GitHub bills the run to that
              repo's action minutes.
            </DialogContentText>
            {confirmRow?.description && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                {confirmRow.description}
              </Typography>
            )}
          </DialogContent>
          <DialogActions>
            <Button
              onClick={() => setConfirmRow(null)}
              disabled={runningId !== null}
            >
              Cancel
            </Button>
            <Button
              variant="contained"
              startIcon={<PlayArrowIcon />}
              disabled={runningId !== null || confirmRow === null}
              onClick={() => confirmRow && doRun(confirmRow)}
            >
              {runningId !== null ? 'Dispatching…' : 'Run workflow'}
            </Button>
          </DialogActions>
        </Dialog>

        <Snackbar
          open={snack.open}
          autoHideDuration={6000}
          onClose={() => setSnack((s) => ({ ...s, open: false }))}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert
            onClose={() => setSnack((s) => ({ ...s, open: false }))}
            severity={snack.severity}
            variant="filled"
            sx={{ width: '100%' }}
            action={
              snack.href ? (
                <Link
                  href={snack.href}
                  target="_blank"
                  rel="noreferrer"
                  color="inherit"
                  underline="always"
                  sx={{ mr: 1 }}
                >
                  view run
                </Link>
              ) : undefined
            }
          >
            {snack.message}
          </Alert>
        </Snackbar>
      </Box>
    </motion.div>
  )
}
