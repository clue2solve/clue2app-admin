import { useState, useEffect, useCallback } from 'react'
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
  TablePagination,
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
} from '@mui/icons-material'
import { motion } from 'framer-motion'
import { AGENT_DESCRIPTIONS } from './AgentDetailPage'

// The Platform Agents backend runs as a Knative service in-cluster and
// is reachable at the public URL below. We call it directly from the
// browser rather than proxying through the admin backend.
//
// NOTE: CORS on the agents ksvc must allow admin.control.apps.clue2.app
// (and admin.clue2.app). If requests fail with a CORS error, update the
// clue2app-agents ksvc CORS allow-list.
const AGENTS_URL = 'https://clue2app-agents.control.apps.clue2.app'

// The Agent Alerts feed lives on the coordinator (persisted from
// OTel-emitted agent alerts). Reads require a JWT — reuse the token the
// admin app already stashes in sessionStorage under 'c2a_token'.
const COORDINATOR_URL = 'https://coordinator.control.apps.clue2.app'

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
}

interface DashboardSummary {
  total_agents?: number
  running_agents?: number
  total_checks?: number
  total_issues_detected?: number
  total_issues_healed?: number
  heal_rate?: number
}

interface Dashboard {
  summary?: DashboardSummary
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
}

interface AgentAlert {
  id: string
  severity?: string
  title?: string
  description?: string
  createdOn?: string
  attributes?: Record<string, unknown>
}

const SEVERITY_META: Record<
  string,
  { color: string; Icon: typeof ErrorIcon; label: string }
> = {
  critical: { color: '#ef4444', Icon: ErrorIcon, label: 'critical' },
  warning: { color: '#f59e0b', Icon: Warning, label: 'warning' },
  info: { color: '#3b82f6', Icon: Info, label: 'info' },
}

const severityMeta = (s?: string) =>
  SEVERITY_META[(s || '').toLowerCase()] || SEVERITY_META.info

function AgentAlertsPanel() {
  const theme = useTheme()
  const isDark = theme.palette.mode === 'dark'

  const [rows, setRows] = useState<AgentAlert[]>([])
  const [totalElements, setTotalElements] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(20)
  const [drillDown, setDrillDown] = useState<AgentAlert | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchAlerts = useCallback(async () => {
    try {
      const token = sessionStorage.getItem('c2a_token')
      const res = await fetch(
        `${COORDINATOR_URL}/api/notifications/agent-alerts/${page}/${pageSize}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setRows(data.content || [])
      setTotalElements(data.totalElements || 0)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load alerts')
    }
  }, [page, pageSize])

  useEffect(() => {
    fetchAlerts()
    const id = setInterval(fetchAlerts, 30000)
    return () => clearInterval(id)
  }, [fetchAlerts])

  const panelSx = {
    p: 0,
    borderRadius: 2,
    mb: 2,
    overflow: 'hidden',
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

  return (
    <Paper sx={panelSx}>
      <Box sx={{ display: 'flex', alignItems: 'center', px: 2, pt: 2 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          fontWeight={600}
          textTransform="uppercase"
          letterSpacing={0.5}
          sx={{ flexGrow: 1 }}
        >
          Agent Alerts &nbsp;·&nbsp; {totalElements} total
        </Typography>
      </Box>

      {error && (
        <Alert
          severity="error"
          sx={{ m: 2, borderRadius: 2 }}
          onClose={() => setError(null)}
        >
          {error}
        </Alert>
      )}

      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={thSx}>Severity</TableCell>
              <TableCell sx={thSx}>Title</TableCell>
              <TableCell sx={thSx}>Suggested Fix</TableCell>
              <TableCell sx={thSx}>When</TableCell>
              <TableCell sx={thSx} align="right">
                Details
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  sx={{ ...tdSx, py: 4, textAlign: 'center' }}
                >
                  <Typography variant="caption" color="text.secondary">
                    No agent alerts yet — agents emit on their cadences (30m–6h).
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => {
              const meta = severityMeta(row.severity)
              const IconComp = meta.Icon
              return (
                <TableRow key={row.id} hover>
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
                  </TableCell>
                  <TableCell sx={tdSx}>
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
                      {row.description || '—'}
                    </Typography>
                  </TableCell>
                  <TableCell sx={tdSx}>
                    <Typography variant="caption" color="text.secondary">
                      {row.createdOn
                        ? new Date(row.createdOn).toLocaleString()
                        : '—'}
                    </Typography>
                  </TableCell>
                  <TableCell sx={tdSx} align="right">
                    <Tooltip title="View attributes">
                      <IconButton size="small" onClick={() => setDrillDown(row)}>
                        <Info sx={{ fontSize: 16 }} />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </TableContainer>

      <TablePagination
        component="div"
        count={totalElements}
        page={page}
        onPageChange={(_, p) => setPage(p)}
        rowsPerPage={pageSize}
        onRowsPerPageChange={(e) => {
          setPageSize(parseInt(e.target.value, 10))
          setPage(0)
        }}
        rowsPerPageOptions={[10, 20, 50, 100]}
        sx={{ borderTop: `1px solid ${isDark ? '#1e293b' : '#e2e8f0'}` }}
      />

      <Dialog
        open={Boolean(drillDown)}
        onClose={() => setDrillDown(null)}
        maxWidth="md"
        fullWidth
        PaperProps={{
          sx: { borderRadius: 3, bgcolor: isDark ? '#0f172a' : '#fff' },
        }}
      >
        <DialogTitle sx={{ pb: 1 }}>
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              {drillDown &&
                (() => {
                  const meta = severityMeta(drillDown.severity)
                  const IconComp = meta.Icon
                  return <IconComp sx={{ color: meta.color }} />
                })()}
              <Typography variant="h6" fontWeight={600}>
                {drillDown?.title || 'Alert'}
              </Typography>
            </Box>
            <IconButton onClick={() => setDrillDown(null)} size="small">
              <Close fontSize="small" />
            </IconButton>
          </Box>
        </DialogTitle>
        <DialogContent>
          {drillDown?.description && (
            <Box sx={{ mb: 2 }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontSize: '0.65rem' }}
              >
                Suggested fix
              </Typography>
              <Typography variant="body2">{drillDown.description}</Typography>
            </Box>
          )}
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontSize: '0.65rem' }}
          >
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
              {JSON.stringify(drillDown?.attributes || {}, null, 2)}
            </pre>
          </Paper>
        </DialogContent>
      </Dialog>
    </Paper>
  )
}

interface AgentsTabProps {
  /**
   * Called when the user clicks an agent row. Optional so callers that don't
   * yet route to the detail page (and tests) can render this tab unchanged.
   */
  onOpenAgent?: (agentName: string) => void
}

function AgentsTab({ onOpenAgent }: AgentsTabProps = {}) {
  const theme = useTheme()
  const isDark = theme.palette.mode === 'dark'

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [healingAgent, setHealingAgent] = useState<string | null>(null)
  const [healResult, setHealResult] = useState<HealResult | null>(null)

  const fetchDashboard = useCallback(async () => {
    try {
      const response = await fetch(`${AGENTS_URL}/dashboard`)
      if (!response.ok) throw new Error('Failed to fetch agents dashboard')
      const data = (await response.json()) as Dashboard
      setDashboard(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch dashboard')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchDashboard()
    const interval = setInterval(fetchDashboard, 30000)
    return () => clearInterval(interval)
  }, [fetchDashboard])

  const handleStartAgent = async (agentName: string) => {
    try {
      await fetch(`${AGENTS_URL}/agents/${agentName}/start`, { method: 'POST' })
      fetchDashboard()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start agent')
    }
  }

  const handleStopAgent = async (agentName: string) => {
    try {
      await fetch(`${AGENTS_URL}/agents/${agentName}/stop`, { method: 'POST' })
      fetchDashboard()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop agent')
    }
  }

  const handleTriggerHeal = async (agentName: string, dryRun = false) => {
    setHealingAgent(agentName)
    try {
      const response = await fetch(`${AGENTS_URL}/heal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: agentName, dry_run: dryRun }),
      })
      const result = (await response.json()) as Omit<HealResult, 'agent'>
      setHealResult({ agent: agentName, ...result })
      fetchDashboard()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger heal')
    } finally {
      setHealingAgent(null)
    }
  }

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

  const summary = dashboard?.summary || {}

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
    >
      <Box sx={{ p: 3, maxWidth: 1200, mx: 'auto' }}>
        {/* Header */}
        <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
          <Typography variant="h6" fontWeight={600} sx={{ flexGrow: 1 }}>
            Platform Agents
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ mr: 2 }}>
            {dashboard?.uptime ? `Uptime: ${dashboard.uptime}` : ''}
          </Typography>
          <Tooltip title="Refresh">
            <IconButton
              size="small"
              onClick={() => {
                setLoading(true)
                fetchDashboard().finally(() => setLoading(false))
              }}
            >
              <Refresh fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>

        {error && (
          <Alert
            severity="error"
            sx={{ mb: 2, borderRadius: 2 }}
            onClose={() => setError(null)}
          >
            {error}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
            <CircularProgress />
          </Box>
        ) : (
          <>
            {/* Summary Stats */}
            <Box sx={{ display: 'flex', gap: 4, mb: 3, flexWrap: 'wrap' }}>
              {[
                { label: 'Agents', value: summary.total_agents || 0, color: '#F97316' },
                { label: 'Running', value: summary.running_agents || 0, color: '#10b981' },
                { label: 'Checks', value: summary.total_checks || 0, color: '#06b6d4' },
                {
                  label: 'Issues',
                  value: summary.total_issues_detected || 0,
                  color: '#f59e0b',
                },
                {
                  label: 'Healed',
                  value: summary.total_issues_healed || 0,
                  color: '#10b981',
                },
                {
                  label: 'Heal Rate',
                  value: `${summary.heal_rate ?? 100}%`,
                  color: '#8b5cf6',
                },
              ].map((stat) => (
                <Box
                  key={stat.label}
                  sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5 }}
                >
                  <Typography variant="h5" fontWeight={700} sx={{ color: stat.color }}>
                    {stat.value}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {stat.label}
                  </Typography>
                </Box>
              ))}
            </Box>

            {/* Agents Table */}
            <Paper sx={{ ...panelSx, p: 0, overflow: 'hidden' }}>
              <Typography
                variant="caption"
                color="text.secondary"
                fontWeight={600}
                textTransform="uppercase"
                letterSpacing={0.5}
                sx={{ px: 2, pt: 2, display: 'block' }}
              >
                Agent Status
              </Typography>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={thSx}>Agent</TableCell>
                      <TableCell sx={thSx}>Status</TableCell>
                      <TableCell sx={thSx}>Health</TableCell>
                      <TableCell align="right" sx={thSx}>
                        Checks
                      </TableCell>
                      <TableCell align="right" sx={thSx}>
                        Issues
                      </TableCell>
                      <TableCell sx={thSx}>Last Check</TableCell>
                      <TableCell align="right" sx={thSx}>
                        Actions
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {dashboard?.agents?.map((agent) => (
                      <TableRow
                        key={agent.name}
                        hover
                        onClick={() => onOpenAgent?.(agent.name)}
                        sx={{ cursor: onOpenAgent ? 'pointer' : 'default' }}
                      >
                        <TableCell sx={tdSx}>
                          <Typography variant="body2" fontWeight={500}>
                            {agent.display_name}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ fontSize: '0.65rem' }}
                          >
                            {agent.type}
                          </Typography>
                          {AGENT_DESCRIPTIONS[agent.name] && (
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              sx={{
                                display: 'block',
                                fontSize: '0.7rem',
                                lineHeight: 1.35,
                                mt: 0.5,
                                maxWidth: 420,
                              }}
                            >
                              {AGENT_DESCRIPTIONS[agent.name]}
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell sx={tdSx}>
                          <Chip
                            size="small"
                            label={agent.is_running ? 'Running' : 'Stopped'}
                            variant="outlined"
                            sx={{
                              fontSize: '0.65rem',
                              height: 20,
                              borderColor: agent.is_running
                                ? '#10b981'
                                : isDark
                                ? '#334155'
                                : '#e2e8f0',
                              color: agent.is_running ? '#10b981' : 'text.secondary',
                            }}
                          />
                        </TableCell>
                        <TableCell sx={tdSx}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            {agent.health_score >= 80 ? (
                              <CheckCircle sx={{ fontSize: 14, color: '#10b981' }} />
                            ) : agent.health_score >= 50 ? (
                              <Warning sx={{ fontSize: 14, color: '#f59e0b' }} />
                            ) : (
                              <ErrorIcon sx={{ fontSize: 14, color: '#ef4444' }} />
                            )}
                            <Typography
                              variant="body2"
                              fontWeight={500}
                              sx={{
                                color:
                                  agent.health_score >= 80
                                    ? '#10b981'
                                    : agent.health_score >= 50
                                    ? '#f59e0b'
                                    : '#ef4444',
                              }}
                            >
                              {agent.health_score}%
                            </Typography>
                          </Box>
                        </TableCell>
                        <TableCell align="right" sx={tdSx}>
                          <Typography variant="body2" color="text.secondary">
                            {agent.checks_performed}
                          </Typography>
                        </TableCell>
                        <TableCell align="right" sx={tdSx}>
                          <Typography variant="body2">
                            <span style={{ color: '#f59e0b' }}>
                              {agent.issues_detected}
                            </span>
                            {' / '}
                            <span style={{ color: '#10b981' }}>
                              {agent.issues_healed}
                            </span>
                          </Typography>
                        </TableCell>
                        <TableCell sx={tdSx}>
                          <Typography variant="caption" color="text.secondary">
                            {agent.last_check
                              ? new Date(agent.last_check).toLocaleString()
                              : 'Never'}
                          </Typography>
                        </TableCell>
                        <TableCell
                          align="right"
                          sx={tdSx}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Box
                            sx={{
                              display: 'flex',
                              gap: 0.25,
                              justifyContent: 'flex-end',
                            }}
                          >
                            {agent.is_running ? (
                              <Tooltip title="Stop">
                                <IconButton
                                  size="small"
                                  onClick={() => handleStopAgent(agent.name)}
                                >
                                  <Stop sx={{ fontSize: 16, color: '#ef4444' }} />
                                </IconButton>
                              </Tooltip>
                            ) : (
                              <Tooltip title="Start">
                                <IconButton
                                  size="small"
                                  onClick={() => handleStartAgent(agent.name)}
                                >
                                  <PlayArrow sx={{ fontSize: 16, color: '#10b981' }} />
                                </IconButton>
                              </Tooltip>
                            )}
                            <Tooltip title="Dry Run">
                              <IconButton
                                size="small"
                                onClick={() => handleTriggerHeal(agent.name, true)}
                                disabled={healingAgent === agent.name}
                              >
                                <BugReport sx={{ fontSize: 16 }} />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title="Heal">
                              <IconButton
                                size="small"
                                onClick={() => handleTriggerHeal(agent.name, false)}
                                disabled={healingAgent === agent.name}
                              >
                                {healingAgent === agent.name ? (
                                  <CircularProgress size={14} />
                                ) : (
                                  <Healing sx={{ fontSize: 16, color: '#F97316' }} />
                                )}
                              </IconButton>
                            </Tooltip>
                          </Box>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Paper>

            {/* Alerts feed (OTel-emitted agent alerts persisted by coordinator) */}
            <AgentAlertsPanel />

            {/* Service Info */}
            <Box sx={{ ...panelSx, py: 1.5 }}>
              <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {[
                  { label: 'Service', value: dashboard?.service },
                  { label: 'Version', value: dashboard?.version },
                  {
                    label: 'Started',
                    value: dashboard?.started_at
                      ? new Date(dashboard.started_at).toLocaleString()
                      : 'N/A',
                  },
                ]
                  .filter((x) => x.value)
                  .map((item) => (
                    <Box key={item.label}>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ fontSize: '0.65rem' }}
                      >
                        {item.label}
                      </Typography>
                      <Typography variant="body2">{item.value}</Typography>
                    </Box>
                  ))}
              </Box>
            </Box>
          </>
        )}

        {/* Heal Result Dialog */}
        <Dialog
          open={Boolean(healResult)}
          onClose={() => setHealResult(null)}
          maxWidth="sm"
          fullWidth
          PaperProps={{
            sx: { borderRadius: 3, bgcolor: isDark ? '#0f172a' : '#fff' },
          }}
        >
          <DialogTitle sx={{ pb: 1 }}>
            <Box
              sx={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {healResult?.success ? (
                  <CheckCircle sx={{ color: '#10b981' }} />
                ) : (
                  <ErrorIcon sx={{ color: '#ef4444' }} />
                )}
                <Typography variant="h6" fontWeight={600}>
                  Heal Result — {healResult?.agent}
                </Typography>
              </Box>
              <IconButton onClick={() => setHealResult(null)} size="small">
                <Close fontSize="small" />
              </IconButton>
            </Box>
          </DialogTitle>
          <DialogContent>
            <Box sx={{ display: 'flex', gap: 4, mb: 2 }}>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Issues Detected
                </Typography>
                <Typography variant="h5" fontWeight={700} sx={{ color: '#f59e0b' }}>
                  {healResult?.issues_detected || 0}
                </Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Issues Healed
                </Typography>
                <Typography variant="h5" fontWeight={700} sx={{ color: '#10b981' }}>
                  {healResult?.issues_healed || 0}
                </Typography>
              </Box>
            </Box>

            {healResult?.actions && healResult.actions.length > 0 && (
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={thSx}>App</TableCell>
                      <TableCell sx={thSx}>Action</TableCell>
                      <TableCell align="center" sx={thSx}>
                        Result
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {healResult.actions.map((action, idx) => (
                      <TableRow key={idx}>
                        <TableCell sx={tdSx}>
                          <Typography variant="body2">
                            {action.app_name || action.node || 'N/A'}
                          </Typography>
                        </TableCell>
                        <TableCell sx={tdSx}>
                          <Typography variant="body2">{action.action}</Typography>
                        </TableCell>
                        <TableCell align="center" sx={tdSx}>
                          {action.success ? (
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

            {healResult?.error && (
              <Alert severity="error" sx={{ mt: 2, borderRadius: 2 }}>
                {healResult.error}
              </Alert>
            )}
          </DialogContent>
        </Dialog>
      </Box>
    </motion.div>
  )
}

export default AgentsTab
