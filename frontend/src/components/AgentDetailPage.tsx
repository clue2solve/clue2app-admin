import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Box,
  Typography,
  IconButton,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Tooltip,
  useTheme,
  Dialog,
  DialogTitle,
  DialogContent,
  Alert,
  CircularProgress,
  Button,
  Divider,
  Grid,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Collapse,
  Skeleton,
} from '@mui/material'
import {
  PlayArrow,
  Stop,
  Refresh,
  CheckCircle,
  Error as ErrorIcon,
  Warning,
  BugReport,
  Healing,
  Close,
  Info,
  ArrowBack,
  ExpandMore,
  PlayCircleOutline,
} from '@mui/icons-material'
import { motion } from 'framer-motion'

// Same endpoints AgentsTab uses.
const AGENTS_URL = 'https://clue2app-agents.control.apps.clue2.app'
const COORDINATOR_URL = 'https://coordinator.control.apps.clue2.app'

// -----------------------------------------------------------------------------
// Shared types (kept in-file so the detail page is self-contained).
// -----------------------------------------------------------------------------

interface AgentInfo {
  name: string
  display_name: string
  type: string
  is_running: boolean
  health_score: number
  checks_performed: number
  issues_detected: number
  issues_healed: number
  last_check: string | null
  started_at?: string | null
  check_interval?: number
  max_retries?: number
  last_error?: string | null
}

interface Dashboard {
  summary?: {
    total_agents?: number
    running_agents?: number
    total_checks?: number
    total_issues_detected?: number
    total_issues_healed?: number
    heal_rate?: number
  }
  agents?: AgentInfo[]
  uptime?: string
  service?: string
  version?: string
  started_at?: string
}

interface HealAction {
  app_name?: string
  node?: string
  action: string
  success: boolean
}

interface HealResult {
  agent: string
  success?: boolean
  issues_detected?: number
  issues_healed?: number
  actions?: HealAction[]
  error?: string
  dry_run?: boolean
  timestamp?: string
}

interface AgentStatus {
  name: string
  is_running: boolean
  started_at?: string | null
  last_check?: string | null
  checks_performed?: number
  issues_detected?: number
  issues_healed?: number
  last_error?: string | null
  check_interval?: number
  max_retries?: number
  consecutive_failures?: number
  watched_resources?: string[]
}

interface HistoryAction {
  timestamp?: string
  action?: string
  type?: string
  success?: boolean
  dry_run?: boolean
  duration?: number
  duration_ms?: number
  resources_scanned?: number
  issues_found?: number
  issues_detected?: number
  actions?: HealAction[]
  actions_attempted?: number
  details?: unknown
  [key: string]: unknown
}

interface HistoryResponse {
  agent: string
  actions: HistoryAction[]
  total_actions?: number
}

interface AgentAlert {
  id: string
  severity?: string
  title?: string
  description?: string
  createdOn?: string
  read?: boolean
  attributes?: Record<string, unknown>
}

interface AlertsPage {
  content?: AgentAlert[]
  totalElements?: number
}

const SEVERITY_META: Record<
  string,
  { color: string; Icon: typeof ErrorIcon; label: string }
> = {
  critical: { color: '#ef4444', Icon: ErrorIcon, label: 'critical' },
  warning: { color: '#f59e0b', Icon: Warning, label: 'warning' },
  info: { color: '#3b82f6', Icon: Info, label: 'info' },
}

// Short one-line description of what each agent actually does. Static
// registry so the detail page has copy without a backend change. If a
// name isn't listed here the header falls back to just "{type} · {name}"
// (the pre-registry behavior). Also imported by AgentsTab for the list.
export const AGENT_DESCRIPTIONS: Record<string, string> = {
  'ecr-healer':
    'Deletes ECR repositories for apps that no longer exist. Prevents unbounded image-storage growth from long-deleted apps.',
  'disk-pressure':
    'Watches EKS nodes for MemoryPressure/DiskPressure conditions and alerts before workloads get evicted.',
  'node-scaler':
    'Scales the EKS node group up when pods are Pending due to insufficient capacity.',
  'builder-health':
    'Watches kpack Build resources for wedged Succeeded=False states and prompts a retry (delete failed Build → rebuild annotation).',
  'platform-health':
    'Broad periodic health scan (secrets, service accounts, kpack drift) via core REST endpoints. Umbrella check for everything not covered by a dedicated agent.',
  'cost-tracker':
    'Persists per-service daily CCU + $ cost snapshots to the coordinator (cost_snapshots table). Drives the Billing tab.',
  'git-creds-health':
    'Scans control-namespace git-credential secrets (kpack PATs, GitHub App tokens) for expiration or SAML-SSO drift. Warns 14 days ahead of dead.',
  'cert-health':
    'Watches cert-manager Certificate resources for renewal failures on public app hostnames.',
  'buildpack-stack':
    'Monitors kpack ClusterStack + ClusterBuilder drift; alerts when base images fall behind upstream Paketo releases.',
  'github-ratelimit':
    'Watches GitHub API rate-limit headroom for our shared PATs so we notice throttling before builds stall.',
  'postgres-health':
    'Checks RDS reachability + connection-pool headroom from inside the cluster. Alerts when max_connections is close.',
  'aws-iam-health':
    'Validates that IAM roles + policies referenced by service accounts (IRSA + explicit-cred users) still exist and have required permissions.',
  'llm-upstream':
    'Monitors upstream LLM providers (OpenAI, Anthropic) for reachability, rate-limit headroom, and 5xx spikes from the gateway.',
  'project-bootstrap-drift':
    'Detects namespace/RBAC/ServiceAccount drift between what project bootstrap should have created and what actually exists.',
  'build-repair':
    'Auto-repairs specific known kpack build failure patterns (libatomic missing, node version pin, etc.). Watches then heals.',
  'surface-drift':
    'Detects when live cluster state has drifted from the declared config (like ArgoCD, but without ArgoCD).',
}

const severityMeta = (s?: string) =>
  SEVERITY_META[(s || '').toLowerCase()] || SEVERITY_META.info

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return String(iso)
  }
}

function fmtDuration(secs?: number): string {
  if (secs === undefined || secs === null) return '—'
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function ageOf(iso?: string | null): string {
  if (!iso) return '—'
  try {
    const diff = Math.max(0, Date.now() - new Date(iso).getTime())
    const s = Math.floor(diff / 1000)
    if (s < 60) return `${s}s ago`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
  } catch {
    return '—'
  }
}

function healthColor(score: number): string {
  if (score >= 80) return '#10b981'
  if (score >= 50) return '#f59e0b'
  return '#ef4444'
}

function isHealAction(a: HistoryAction): boolean {
  const t = (a.type || a.action || '').toString().toLowerCase()
  return t.includes('heal')
}

function isCheckAction(a: HistoryAction): boolean {
  const t = (a.type || a.action || '').toString().toLowerCase()
  return !t.includes('heal') || !a.actions
}

function getActionTimestamp(a: HistoryAction): string | undefined {
  return a.timestamp
}

// -----------------------------------------------------------------------------
// Sub-component: alert drill-down dialog
// -----------------------------------------------------------------------------

interface AlertDetailDialogProps {
  alert: AgentAlert | null
  onClose: () => void
}

function AlertDetailDialog({ alert, onClose }: AlertDetailDialogProps) {
  const theme = useTheme()
  const isDark = theme.palette.mode === 'dark'
  return (
    <Dialog
      open={Boolean(alert)}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{ sx: { borderRadius: 3, bgcolor: isDark ? '#0f172a' : '#fff' } }}
    >
      <DialogTitle sx={{ pb: 1 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {alert && (() => {
              const meta = severityMeta(alert.severity)
              const IconComp = meta.Icon
              return <IconComp sx={{ color: meta.color }} />
            })()}
            <Typography variant="h6" fontWeight={600}>
              {alert?.title || 'Alert'}
            </Typography>
          </Box>
          <IconButton onClick={onClose} size="small">
            <Close fontSize="small" />
          </IconButton>
        </Box>
      </DialogTitle>
      <DialogContent>
        {alert?.description && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem' }}>
              Suggested fix
            </Typography>
            <Typography variant="body2">{alert.description}</Typography>
          </Box>
        )}
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem' }}>
          Attributes
        </Typography>
        <Paper
          elevation={0}
          sx={{
            mt: 0.5,
            p: 1.5,
            borderRadius: 1,
            overflow: 'auto',
            bgcolor: isDark ? '#020617' : '#f8fafc',
            border: `1px solid ${isDark ? '#1e293b' : '#e2e8f0'}`,
            fontFamily: 'ui-monospace, SFMono-Regular, monospace',
            fontSize: '0.75rem',
            maxHeight: 380,
          }}
        >
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {JSON.stringify(alert?.attributes || {}, null, 2)}
          </pre>
        </Paper>
      </DialogContent>
    </Dialog>
  )
}

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

interface AgentDetailPageProps {
  agentName: string
  onBack: () => void
}

export default function AgentDetailPage({ agentName, onBack }: AgentDetailPageProps) {
  const theme = useTheme()
  const isDark = theme.palette.mode === 'dark'

  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [statusUnavailable, setStatusUnavailable] = useState(false)
  const [history, setHistory] = useState<HistoryAction[] | null>(null)
  const [historyUnavailable, setHistoryUnavailable] = useState(false)
  const [alerts, setAlerts] = useState<AgentAlert[] | null>(null)
  const [alertsError, setAlertsError] = useState<string | null>(null)
  const [alertsAuthNeeded, setAlertsAuthNeeded] = useState(false)

  // Client-side session-only sparkline of health-score samples.
  const scoreHistoryRef = useRef<Array<{ ts: number; score: number }>>([])
  const [scoreHistoryVersion, bumpScoreHistory] = useState(0)

  // Action state
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [healing, setHealing] = useState(false)
  const [triggering, setTriggering] = useState(false)
  const [checkNowUnavailable, setCheckNowUnavailable] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [inlineHealResult, setInlineHealResult] = useState<HealResult | null>(null)
  const [backgroundRefetching, setBackgroundRefetching] = useState(false)

  // Alert drill-down
  const [drillDown, setDrillDown] = useState<AgentAlert | null>(null)

  // Heal-history row expansion
  const [expandedHealIdx, setExpandedHealIdx] = useState<number | null>(null)

  const agent = useMemo<AgentInfo | undefined>(
    () => dashboard?.agents?.find((a) => a.name === agentName),
    [dashboard, agentName],
  )

  // -----------------------------------------------------------------------
  // Fetchers
  // -----------------------------------------------------------------------

  const fetchDashboard = useCallback(async () => {
    try {
      const res = await fetch(`${AGENTS_URL}/dashboard`)
      if (!res.ok) return
      const data = (await res.json()) as Dashboard
      setDashboard(data)
    } catch {
      // silent — action error will surface directly on interaction
    }
  }, [])

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${AGENTS_URL}/agents/${agentName}/status`)
      if (!res.ok) {
        setStatusUnavailable(true)
        return
      }
      const data = (await res.json()) as AgentStatus
      setStatus(data)
      setStatusUnavailable(false)
    } catch {
      setStatusUnavailable(true)
    }
  }, [agentName])

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch(`${AGENTS_URL}/agents/${agentName}/history?limit=50`)
      if (!res.ok) {
        setHistoryUnavailable(true)
        setHistory([])
        return
      }
      const data = (await res.json()) as HistoryResponse
      setHistory(Array.isArray(data.actions) ? data.actions : [])
      setHistoryUnavailable(false)
    } catch {
      setHistoryUnavailable(true)
      setHistory([])
    }
  }, [agentName])

  const fetchAlerts = useCallback(async () => {
    const token = sessionStorage.getItem('c2a_token')
    if (!token) {
      setAlertsAuthNeeded(true)
      return
    }
    try {
      const res = await fetch(
        `${COORDINATOR_URL}/api/notifications/agent-alerts/0/100`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (res.status === 401 || res.status === 403) {
        setAlertsAuthNeeded(true)
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as AlertsPage
      const all = data.content || []
      const forThisAgent = all.filter((a) => {
        const attrs = a.attributes || {}
        const nameCandidates = [
          attrs.agentName,
          attrs.agent_name,
          attrs.agent,
        ].filter(Boolean) as string[]
        return nameCandidates.some((n) => String(n) === agentName)
      })
      setAlerts(forThisAgent)
      setAlertsError(null)
      setAlertsAuthNeeded(false)
    } catch (e) {
      setAlertsError(e instanceof Error ? e.message : 'Failed to load alerts')
    }
  }, [agentName])

  // Initial + 30s poll for all endpoints.
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setBackgroundRefetching(true)
      await Promise.allSettled([
        fetchDashboard(),
        fetchStatus(),
        fetchHistory(),
        fetchAlerts(),
      ])
      if (!cancelled) setBackgroundRefetching(false)
    }
    run()
    const id = setInterval(run, 30000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [fetchDashboard, fetchStatus, fetchHistory, fetchAlerts])

  // Feed the client-side sparkline whenever the dashboard-derived score changes.
  useEffect(() => {
    if (!agent) return
    const buf = scoreHistoryRef.current
    const last = buf[buf.length - 1]
    const now = Date.now()
    if (!last || last.score !== agent.health_score || now - last.ts > 25000) {
      buf.push({ ts: now, score: agent.health_score })
      if (buf.length > 60) buf.shift()
      bumpScoreHistory((v) => v + 1)
    }
  }, [agent])

  // Scroll to top when detail view mounts.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  const refreshAll = useCallback(async () => {
    setBackgroundRefetching(true)
    await Promise.allSettled([
      fetchDashboard(),
      fetchStatus(),
      fetchHistory(),
      fetchAlerts(),
    ])
    setBackgroundRefetching(false)
  }, [fetchDashboard, fetchStatus, fetchHistory, fetchAlerts])

  const handleStart = async () => {
    setStarting(true)
    setActionError(null)
    try {
      await fetch(`${AGENTS_URL}/agents/${agentName}/start`, { method: 'POST' })
      await refreshAll()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to start agent')
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    setStopping(true)
    setActionError(null)
    try {
      await fetch(`${AGENTS_URL}/agents/${agentName}/stop`, { method: 'POST' })
      await refreshAll()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to stop agent')
    } finally {
      setStopping(false)
    }
  }

  const handleHeal = async (dryRun: boolean) => {
    setHealing(true)
    setActionError(null)
    try {
      const res = await fetch(`${AGENTS_URL}/heal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: agentName, dry_run: dryRun }),
      })
      const result = (await res.json()) as Omit<HealResult, 'agent'>
      setInlineHealResult({
        agent: agentName,
        dry_run: dryRun,
        timestamp: new Date().toISOString(),
        ...result,
      })
      await refreshAll()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to trigger heal')
    } finally {
      setHealing(false)
    }
  }

  const handleTriggerCheck = async () => {
    setTriggering(true)
    setActionError(null)
    try {
      const res = await fetch(`${AGENTS_URL}/agents/${agentName}/check`, {
        method: 'POST',
      })
      if (res.status === 404) {
        setCheckNowUnavailable(true)
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await refreshAll()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to trigger check')
    } finally {
      setTriggering(false)
    }
  }

  // -----------------------------------------------------------------------
  // Style helpers
  // -----------------------------------------------------------------------

  const panelSx = {
    p: 2,
    borderRadius: 2,
    mb: 2,
    bgcolor: isDark ? 'background.paper' : '#fff',
    border: `1px solid ${isDark ? '#1e293b' : '#e2e8f0'}`,
  }
  const thSx = {
    fontWeight: 600,
    fontSize: '0.75rem',
    color: 'text.secondary',
    borderColor: isDark ? '#1e293b' : undefined,
  }
  const tdSx = { borderColor: isDark ? '#1e293b' : undefined }

  // -----------------------------------------------------------------------
  // Derived data
  // -----------------------------------------------------------------------

  const healRate = useMemo(() => {
    if (!agent || !agent.issues_detected) return null
    return Math.round((agent.issues_healed / agent.issues_detected) * 100)
  }, [agent])

  const historyChecks = useMemo<HistoryAction[]>(() => {
    if (!history) return []
    return history.filter(isCheckAction)
  }, [history])

  const historyHeals = useMemo<HistoryAction[]>(() => {
    const fromHistory = history ? history.filter(isHealAction) : []
    if (inlineHealResult) {
      const synthetic: HistoryAction = {
        timestamp: inlineHealResult.timestamp,
        type: 'heal',
        action: 'manual heal',
        success: inlineHealResult.success,
        dry_run: inlineHealResult.dry_run,
        actions: inlineHealResult.actions,
        actions_attempted: inlineHealResult.actions?.length,
        issues_detected: inlineHealResult.issues_detected,
      }
      return [synthetic, ...fromHistory]
    }
    return fromHistory
  }, [history, inlineHealResult])

  const openAlerts = useMemo(
    () => (alerts || []).filter((a) => !a.read),
    [alerts],
  )
  const closedAlerts = useMemo(
    () => (alerts || []).filter((a) => a.read).slice(0, 20),
    [alerts],
  )

  const sparkline = useMemo(() => {
    const pts = scoreHistoryRef.current
    if (pts.length < 2) return null
    const w = 320
    const h = 60
    const xs = pts.map((_, i) => (i / (pts.length - 1)) * w)
    const ys = pts.map((p) => h - (p.score / 100) * h)
    const points = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')
    return { w, h, points }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoreHistoryVersion])

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  // Unknown-agent guard
  if (dashboard && !agent) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <Box sx={{ p: 3, maxWidth: 1200, mx: 'auto' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
            <IconButton size="small" onClick={onBack} sx={{ mr: 1 }}>
              <ArrowBack fontSize="small" />
            </IconButton>
            <Typography variant="h6" fontWeight={600}>
              Unknown agent: {agentName}
            </Typography>
          </Box>
          <Alert severity="warning" sx={{ borderRadius: 2 }}>
            No agent named <strong>{agentName}</strong> is registered. It may have
            been renamed or unregistered.
          </Alert>
          <Box sx={{ mt: 2 }}>
            <Button variant="outlined" size="small" onClick={onBack} startIcon={<ArrowBack />}>
              Back to agents
            </Button>
          </Box>
        </Box>
      </motion.div>
    )
  }

  // Initial loading state
  if (!dashboard || !agent) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    )
  }

  const cadence = status?.check_interval ?? agent.check_interval ?? undefined
  const maxRetries = status?.max_retries ?? agent.max_retries ?? undefined
  const consecutiveFailures = status?.consecutive_failures
  const watched = status?.watched_resources || []

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
    >
      <Box sx={{ p: 3, maxWidth: 1200, mx: 'auto' }}>
        {/* Sticky header */}
        <Box
          sx={{
            position: 'sticky',
            top: 0,
            zIndex: 2,
            bgcolor: isDark ? 'background.default' : '#fff',
            pb: 1,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Tooltip title="Back to agents">
              <IconButton size="small" onClick={onBack}>
                <ArrowBack fontSize="small" />
              </IconButton>
            </Tooltip>
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography variant="h6" fontWeight={600} sx={{ lineHeight: 1.2 }}>
                {agent.display_name}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {agent.type} · {agent.name}
              </Typography>
              {AGENT_DESCRIPTIONS[agent.name] && (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ mt: 0.75, maxWidth: 780, lineHeight: 1.4 }}
                >
                  {AGENT_DESCRIPTIONS[agent.name]}
                </Typography>
              )}
            </Box>
            {backgroundRefetching && (
              <CircularProgress size={12} sx={{ mr: 1 }} />
            )}
            <Chip
              size="small"
              label={agent.is_running ? 'Running' : 'Stopped'}
              variant="outlined"
              sx={{
                fontSize: '0.65rem',
                height: 22,
                borderColor: agent.is_running
                  ? '#10b981'
                  : isDark
                  ? '#334155'
                  : '#e2e8f0',
                color: agent.is_running ? '#10b981' : 'text.secondary',
                mr: 1,
              }}
            />
            <Tooltip title="Refresh">
              <IconButton size="small" onClick={refreshAll}>
                <Refresh fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
          <Divider />
        </Box>

        {actionError && (
          <Alert
            severity="error"
            sx={{ my: 2, borderRadius: 2 }}
            onClose={() => setActionError(null)}
          >
            {actionError}
          </Alert>
        )}

        {/* Metadata card */}
        <Paper sx={{ ...panelSx, mt: 2 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            fontWeight={600}
            textTransform="uppercase"
            letterSpacing={0.5}
            sx={{ display: 'block', mb: 1.5 }}
          >
            Metadata
          </Typography>
          <Grid container spacing={2}>
            <MetaCell label="Name" value={agent.name} />
            <MetaCell label="Type" value={agent.type} />
            <MetaCell label="Version" value={dashboard.version} />
            <MetaCell label="Uptime" value={dashboard.uptime} />
            <MetaCell
              label="Cadence"
              value={cadence !== undefined ? `${cadence}s` : undefined}
            />
            <MetaCell label="Max Retries" value={maxRetries?.toString()} />
            <MetaCell label="Last Check" value={fmtDate(agent.last_check)} />
            <MetaCell
              label="Started At"
              value={dashboard.started_at ? fmtDate(dashboard.started_at) : undefined}
            />
          </Grid>

          <Box sx={{ mt: 2 }}>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontSize: '0.65rem' }}
            >
              Watched Resources
            </Typography>
            <Box sx={{ mt: 0.5, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
              {watched.length > 0 ? (
                watched.map((r) => (
                  <Chip
                    key={r}
                    size="small"
                    label={r}
                    variant="outlined"
                    sx={{
                      fontSize: '0.65rem',
                      height: 22,
                      borderColor: isDark ? '#334155' : '#e2e8f0',
                    }}
                  />
                ))
              ) : (
                <Typography variant="caption" color="text.secondary">
                  Not exposed by this agent yet.
                </Typography>
              )}
            </Box>
          </Box>

          {statusUnavailable && (
            <Box
              sx={{
                mt: 1.5,
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
              }}
            >
              <Info sx={{ fontSize: 14, color: 'text.secondary' }} />
              <Typography variant="caption" color="text.secondary">
                Status endpoint unavailable — extended metadata may be missing.
              </Typography>
            </Box>
          )}
        </Paper>

        {/* KPI strip */}
        <Box sx={{ display: 'flex', gap: 4, mb: 3, flexWrap: 'wrap' }}>
          {[
            { label: 'Checks', value: agent.checks_performed, color: '#06b6d4' },
            { label: 'Issues Detected', value: agent.issues_detected, color: '#f59e0b' },
            { label: 'Issues Healed', value: agent.issues_healed, color: '#10b981' },
            {
              label: 'Heal Rate',
              value: healRate !== null ? `${healRate}%` : '—',
              color: '#8b5cf6',
            },
            {
              label: 'Health Score',
              value: `${agent.health_score}%`,
              color: healthColor(agent.health_score),
            },
            {
              label: 'Consecutive Failures',
              value: consecutiveFailures ?? '—',
              color: '#ef4444',
            },
          ].map((stat) => (
            <Box key={stat.label} sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5 }}>
              <Typography variant="h5" fontWeight={700} sx={{ color: stat.color }}>
                {stat.value}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {stat.label}
              </Typography>
            </Box>
          ))}
        </Box>

        {/* Health-score sparkline card */}
        <Paper sx={panelSx}>
          <Typography
            variant="caption"
            color="text.secondary"
            fontWeight={600}
            textTransform="uppercase"
            letterSpacing={0.5}
            sx={{ display: 'block', mb: 1 }}
          >
            Health Score (Session)
          </Typography>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              flexWrap: 'wrap',
            }}
          >
            <Typography
              variant="h3"
              fontWeight={700}
              sx={{ color: healthColor(agent.health_score) }}
            >
              {agent.health_score}%
            </Typography>
            <Box sx={{ flexGrow: 1, minWidth: 200 }}>
              {sparkline ? (
                <Box>
                  <svg
                    width="100%"
                    height={sparkline.h}
                    viewBox={`0 0 ${sparkline.w} ${sparkline.h}`}
                    preserveAspectRatio="none"
                  >
                    <polyline
                      fill="none"
                      stroke={healthColor(agent.health_score)}
                      strokeWidth={2}
                      points={sparkline.points}
                    />
                  </svg>
                  <Typography variant="caption" color="text.secondary">
                    Session-only sparkline · {scoreHistoryRef.current.length} samples
                  </Typography>
                </Box>
              ) : (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Info sx={{ fontSize: 16, color: 'text.secondary' }} />
                  <Typography variant="caption" color="text.secondary">
                    Historical health series not yet exposed by clue2app-agents.
                    Session sparkline will fill as new samples arrive (30s cadence).
                  </Typography>
                </Box>
              )}
            </Box>
          </Box>
        </Paper>

        {/* Recent Checks + Heal History (two-column) */}
        <Grid container spacing={2}>
          <Grid item xs={12} md={6}>
            <Paper sx={{ ...panelSx, mb: 0 }}>
              <Typography
                variant="caption"
                color="text.secondary"
                fontWeight={600}
                textTransform="uppercase"
                letterSpacing={0.5}
                sx={{ display: 'block', mb: 1 }}
              >
                Recent Checks
              </Typography>
              {history === null ? (
                <Box>
                  <Skeleton variant="text" />
                  <Skeleton variant="text" />
                  <Skeleton variant="text" />
                </Box>
              ) : historyChecks.length === 0 ? (
                <EmptySectionState
                  message={
                    historyUnavailable
                      ? 'Detailed check log not yet exposed. Summary counters above reflect lifetime totals.'
                      : 'No checks recorded yet — this agent may not have run since last restart.'
                  }
                />
              ) : (
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell sx={thSx}>When</TableCell>
                        <TableCell sx={thSx}>Duration</TableCell>
                        <TableCell sx={thSx} align="right">Resources</TableCell>
                        <TableCell sx={thSx} align="right">Issues</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {historyChecks.slice(0, 20).map((h, idx) => (
                        <TableRow key={idx}>
                          <TableCell sx={tdSx}>
                            <Typography variant="caption" color="text.secondary">
                              {fmtDate(getActionTimestamp(h))}
                            </Typography>
                          </TableCell>
                          <TableCell sx={tdSx}>
                            <Typography variant="caption" color="text.secondary">
                              {h.duration !== undefined
                                ? fmtDuration(h.duration)
                                : h.duration_ms !== undefined
                                ? `${h.duration_ms}ms`
                                : '—'}
                            </Typography>
                          </TableCell>
                          <TableCell sx={tdSx} align="right">
                            <Typography variant="body2" color="text.secondary">
                              {h.resources_scanned ?? '—'}
                            </Typography>
                          </TableCell>
                          <TableCell sx={tdSx} align="right">
                            <Typography variant="body2" sx={{ color: '#f59e0b' }}>
                              {h.issues_found ?? h.issues_detected ?? '—'}
                            </Typography>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </Paper>
          </Grid>

          <Grid item xs={12} md={6}>
            <Paper sx={{ ...panelSx, mb: 0 }}>
              <Typography
                variant="caption"
                color="text.secondary"
                fontWeight={600}
                textTransform="uppercase"
                letterSpacing={0.5}
                sx={{ display: 'block', mb: 1 }}
              >
                Heal History
              </Typography>
              {history === null && !inlineHealResult ? (
                <Box>
                  <Skeleton variant="text" />
                  <Skeleton variant="text" />
                  <Skeleton variant="text" />
                </Box>
              ) : historyHeals.length === 0 ? (
                <EmptySectionState
                  message={
                    historyUnavailable
                      ? 'Heal log not yet exposed. Trigger a heal below to see its result inline.'
                      : 'No heal actions recorded yet.'
                  }
                />
              ) : (
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell sx={thSx}>When</TableCell>
                        <TableCell sx={thSx}>Mode</TableCell>
                        <TableCell sx={thSx} align="right">Actions</TableCell>
                        <TableCell sx={thSx} align="center">Success</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {historyHeals.slice(0, 20).map((h, idx) => {
                        const expanded = expandedHealIdx === idx
                        const inner = h.actions || []
                        return (
                          <>
                            <TableRow
                              key={`row-${idx}`}
                              hover
                              sx={{ cursor: inner.length ? 'pointer' : 'default' }}
                              onClick={() =>
                                setExpandedHealIdx(expanded ? null : idx)
                              }
                            >
                              <TableCell sx={tdSx}>
                                <Typography variant="caption" color="text.secondary">
                                  {fmtDate(getActionTimestamp(h))}
                                </Typography>
                              </TableCell>
                              <TableCell sx={tdSx}>
                                <Chip
                                  size="small"
                                  label={h.dry_run ? 'dry-run' : 'apply'}
                                  variant="outlined"
                                  sx={{
                                    fontSize: '0.6rem',
                                    height: 18,
                                    color: h.dry_run ? '#3b82f6' : '#F97316',
                                    borderColor: h.dry_run ? '#3b82f6' : '#F97316',
                                  }}
                                />
                              </TableCell>
                              <TableCell sx={tdSx} align="right">
                                <Typography variant="body2" color="text.secondary">
                                  {h.actions_attempted ?? inner.length ?? '—'}
                                </Typography>
                              </TableCell>
                              <TableCell sx={tdSx} align="center">
                                {h.success ? (
                                  <CheckCircle sx={{ fontSize: 16, color: '#10b981' }} />
                                ) : (
                                  <ErrorIcon sx={{ fontSize: 16, color: '#ef4444' }} />
                                )}
                              </TableCell>
                            </TableRow>
                            {inner.length > 0 && (
                              <TableRow key={`exp-${idx}`}>
                                <TableCell colSpan={4} sx={{ ...tdSx, p: 0 }}>
                                  <Collapse in={expanded} timeout="auto" unmountOnExit>
                                    <Box sx={{ p: 2 }}>
                                      <Table size="small">
                                        <TableHead>
                                          <TableRow>
                                            <TableCell sx={thSx}>App / Node</TableCell>
                                            <TableCell sx={thSx}>Action</TableCell>
                                            <TableCell sx={thSx} align="center">
                                              Success
                                            </TableCell>
                                          </TableRow>
                                        </TableHead>
                                        <TableBody>
                                          {inner.map((act, i) => (
                                            <TableRow key={i}>
                                              <TableCell sx={tdSx}>
                                                <Typography variant="body2">
                                                  {act.app_name || act.node || 'N/A'}
                                                </Typography>
                                              </TableCell>
                                              <TableCell sx={tdSx}>
                                                <Typography variant="body2">
                                                  {act.action}
                                                </Typography>
                                              </TableCell>
                                              <TableCell sx={tdSx} align="center">
                                                {act.success ? (
                                                  <CheckCircle
                                                    sx={{ fontSize: 16, color: '#10b981' }}
                                                  />
                                                ) : (
                                                  <ErrorIcon
                                                    sx={{ fontSize: 16, color: '#ef4444' }}
                                                  />
                                                )}
                                              </TableCell>
                                            </TableRow>
                                          ))}
                                        </TableBody>
                                      </Table>
                                    </Box>
                                  </Collapse>
                                </TableCell>
                              </TableRow>
                            )}
                          </>
                        )
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </Paper>
          </Grid>
        </Grid>

        {/* Open Issues */}
        <Paper sx={{ ...panelSx, mt: 2 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            fontWeight={600}
            textTransform="uppercase"
            letterSpacing={0.5}
            sx={{ display: 'block', mb: 1 }}
          >
            Open Issues
          </Typography>
          {alertsAuthNeeded ? (
            <EmptySectionState message="Sign in to load alert feed for this agent." />
          ) : alertsError ? (
            <Alert severity="warning" sx={{ borderRadius: 2 }}>
              {alertsError}
            </Alert>
          ) : alerts === null ? (
            <Box>
              <Skeleton variant="text" />
              <Skeleton variant="text" />
              <Skeleton variant="text" />
            </Box>
          ) : openAlerts.length === 0 ? (
            <EmptySectionState message="No open alerts for this agent." />
          ) : (
            <IssuesTable
              rows={openAlerts}
              onDrillDown={setDrillDown}
              thSx={thSx}
              tdSx={tdSx}
            />
          )}
        </Paper>

        {/* Closed Issues (accordion) */}
        <Accordion sx={{ ...panelSx, p: 0, mt: 0 }}>
          <AccordionSummary expandIcon={<ExpandMore />} sx={{ px: 2 }}>
            <Typography
              variant="caption"
              color="text.secondary"
              fontWeight={600}
              textTransform="uppercase"
              letterSpacing={0.5}
            >
              Closed Issues (last 20)
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ px: 2, pb: 2 }}>
            {alertsAuthNeeded ? (
              <EmptySectionState message="Sign in to load alert feed for this agent." />
            ) : alertsError ? (
              <Alert severity="warning" sx={{ borderRadius: 2 }}>
                {alertsError}
              </Alert>
            ) : closedAlerts.length === 0 ? (
              <EmptySectionState message="No closed alerts for this agent." />
            ) : (
              <IssuesTable
                rows={closedAlerts}
                onDrillDown={setDrillDown}
                thSx={thSx}
                tdSx={tdSx}
              />
            )}
          </AccordionDetails>
        </Accordion>

        {/* Manual actions footer */}
        <Paper sx={{ ...panelSx, mt: 2 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            fontWeight={600}
            textTransform="uppercase"
            letterSpacing={0.5}
            sx={{ display: 'block', mb: 1 }}
          >
            Manual Actions
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {agent.is_running ? (
              <Button
                size="small"
                variant="outlined"
                onClick={handleStop}
                disabled={stopping}
                startIcon={
                  stopping ? <CircularProgress size={12} /> : <Stop sx={{ color: '#ef4444' }} />
                }
                sx={{
                  borderColor: '#ef4444',
                  color: '#ef4444',
                  '&:hover': { borderColor: '#ef4444', bgcolor: 'rgba(239,68,68,0.08)' },
                }}
              >
                Stop
              </Button>
            ) : (
              <Button
                size="small"
                variant="outlined"
                onClick={handleStart}
                disabled={starting}
                startIcon={
                  starting ? <CircularProgress size={12} /> : <PlayArrow sx={{ color: '#10b981' }} />
                }
                sx={{
                  borderColor: '#10b981',
                  color: '#10b981',
                  '&:hover': { borderColor: '#10b981', bgcolor: 'rgba(16,185,129,0.08)' },
                }}
              >
                Start
              </Button>
            )}

            <Tooltip
              title={
                checkNowUnavailable
                  ? 'Endpoint not exposed by agents ksvc yet'
                  : 'Trigger a check now'
              }
            >
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={handleTriggerCheck}
                  disabled={triggering || checkNowUnavailable}
                  startIcon={
                    triggering ? (
                      <CircularProgress size={12} />
                    ) : (
                      <PlayCircleOutline fontSize="small" />
                    )
                  }
                >
                  Trigger Check Now
                </Button>
              </span>
            </Tooltip>

            <Button
              size="small"
              variant="outlined"
              onClick={() => handleHeal(true)}
              disabled={healing}
              startIcon={
                healing ? <CircularProgress size={12} /> : <BugReport fontSize="small" />
              }
            >
              Dry-Run Heal
            </Button>

            <Button
              size="small"
              variant="contained"
              onClick={() => handleHeal(false)}
              disabled={healing}
              startIcon={
                healing ? (
                  <CircularProgress size={12} sx={{ color: '#fff' }} />
                ) : (
                  <Healing fontSize="small" />
                )
              }
              sx={{
                bgcolor: '#F97316',
                '&:hover': { bgcolor: '#ea580c' },
              }}
            >
              Apply Heal
            </Button>
          </Box>

          <Collapse in={Boolean(inlineHealResult)} timeout="auto">
            {inlineHealResult && (
              <Box sx={{ mt: 2 }}>
                <Divider sx={{ mb: 1.5 }} />
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                  {inlineHealResult.success ? (
                    <CheckCircle sx={{ color: '#10b981', fontSize: 18 }} />
                  ) : (
                    <ErrorIcon sx={{ color: '#ef4444', fontSize: 18 }} />
                  )}
                  <Typography variant="body2" fontWeight={600}>
                    {inlineHealResult.dry_run ? 'Dry-run result' : 'Heal result'}
                  </Typography>
                  <Box sx={{ flexGrow: 1 }} />
                  <IconButton size="small" onClick={() => setInlineHealResult(null)}>
                    <Close fontSize="small" />
                  </IconButton>
                </Box>
                <Box sx={{ display: 'flex', gap: 4, mb: 1 }}>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Issues Detected
                    </Typography>
                    <Typography variant="h6" fontWeight={700} sx={{ color: '#f59e0b' }}>
                      {inlineHealResult.issues_detected ?? 0}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Issues Healed
                    </Typography>
                    <Typography variant="h6" fontWeight={700} sx={{ color: '#10b981' }}>
                      {inlineHealResult.issues_healed ?? 0}
                    </Typography>
                  </Box>
                </Box>
                {inlineHealResult.actions && inlineHealResult.actions.length > 0 && (
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell sx={thSx}>App / Node</TableCell>
                          <TableCell sx={thSx}>Action</TableCell>
                          <TableCell sx={thSx} align="center">
                            Result
                          </TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {inlineHealResult.actions.map((act, i) => (
                          <TableRow key={i}>
                            <TableCell sx={tdSx}>
                              <Typography variant="body2">
                                {act.app_name || act.node || 'N/A'}
                              </Typography>
                            </TableCell>
                            <TableCell sx={tdSx}>
                              <Typography variant="body2">{act.action}</Typography>
                            </TableCell>
                            <TableCell sx={tdSx} align="center">
                              {act.success ? (
                                <CheckCircle sx={{ fontSize: 16, color: '#10b981' }} />
                              ) : (
                                <ErrorIcon sx={{ fontSize: 16, color: '#ef4444' }} />
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                )}
                {inlineHealResult.error && (
                  <Alert severity="error" sx={{ mt: 1, borderRadius: 2 }}>
                    {inlineHealResult.error}
                  </Alert>
                )}
              </Box>
            )}
          </Collapse>
        </Paper>

        <AlertDetailDialog alert={drillDown} onClose={() => setDrillDown(null)} />
      </Box>
    </motion.div>
  )
}

// -----------------------------------------------------------------------------
// Local sub-components
// -----------------------------------------------------------------------------

function MetaCell({ label, value }: { label: string; value?: string | number | null }) {
  const isEmpty = value === undefined || value === null || value === ''
  return (
    <Grid item xs={12} sm={6} md={3}>
      <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem' }}>
        {label}
      </Typography>
      <Typography
        variant="body2"
        sx={{ color: isEmpty ? 'text.secondary' : undefined }}
      >
        {isEmpty ? '—' : String(value)}
      </Typography>
    </Grid>
  )
}

function EmptySectionState({ message }: { message: string }) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        py: 2,
        px: 1,
      }}
    >
      <Info sx={{ fontSize: 16, color: 'text.secondary' }} />
      <Typography variant="caption" color="text.secondary">
        {message}
      </Typography>
    </Box>
  )
}

function IssuesTable({
  rows,
  onDrillDown,
  thSx,
  tdSx,
}: {
  rows: AgentAlert[]
  onDrillDown: (a: AgentAlert) => void
  thSx: object
  tdSx: object
}) {
  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={thSx}>Severity</TableCell>
            <TableCell sx={thSx}>Title</TableCell>
            <TableCell sx={thSx}>Detected</TableCell>
            <TableCell sx={thSx}>Age</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => {
            const meta = severityMeta(row.severity)
            const IconComp = meta.Icon
            return (
              <TableRow
                key={row.id}
                hover
                sx={{ cursor: 'pointer' }}
                onClick={() => onDrillDown(row)}
              >
                <TableCell sx={tdSx}>
                  <Chip
                    size="small"
                    icon={
                      <IconComp
                        sx={{ fontSize: 14, color: meta.color + ' !important' }}
                      />
                    }
                    label={meta.label}
                    variant="outlined"
                    sx={{
                      fontSize: '0.65rem',
                      height: 22,
                      fontWeight: 600,
                      color: meta.color,
                      borderColor: meta.color,
                    }}
                  />
                </TableCell>
                <TableCell sx={tdSx}>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {row.title || '(no title)'}
                  </Typography>
                  {row.description && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{
                        display: '-webkit-box',
                        WebkitLineClamp: 1,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {row.description}
                    </Typography>
                  )}
                </TableCell>
                <TableCell sx={tdSx}>
                  <Typography variant="caption" color="text.secondary">
                    {fmtDate(row.createdOn)}
                  </Typography>
                </TableCell>
                <TableCell sx={tdSx}>
                  <Typography variant="caption" color="text.secondary">
                    {ageOf(row.createdOn)}
                  </Typography>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </TableContainer>
  )
}
