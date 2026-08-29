import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Box,
  Typography,
  Paper,
  Chip,
  Button,
  Alert,
  CircularProgress,
  Stack,
  Divider,
  Select,
  MenuItem,
  Checkbox,
  ListItemText,
  InputLabel,
  FormControl,
  ToggleButton,
  ToggleButtonGroup,
  TextField,
  Link as MuiLink,
} from '@mui/material'
import type { SelectChangeEvent } from '@mui/material'
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import { motion } from 'framer-motion'
import { coordinatorGet, ApiError } from '../api'

// -----------------------------------------------------------------------------
// Timeline of deploy events, correlated with the merged PRs that shipped in
// each one. Backend: coordinator's `ReleaseEventController` under
// `/api/platform/releases` (see coordinator/docs/design/release-notes-surface.md).
// Until that lands, this tab shows a friendly empty/error state — it's built
// to the contract, not against a live table yet.
// -----------------------------------------------------------------------------

interface PrRef {
  number: number
  title: string
  author: string | null
  mergedAt: string | null
  url: string
  repo: string | null
}

interface ReleaseEvent {
  id: number
  service: string
  namespace: string
  revision: string
  imageDigest: string | null
  deployedAt: string
  buildStartedAt: string | null
  priorRevision: string | null
  prs: PrRef[]
  notes: string | null
  source: string
}

interface Page<T> {
  content: T[]
  totalElements: number
  totalPages: number
  number: number
  size: number
}

const LAST_SEEN_KEY = 'releases_last_seen'
const PAGE_SIZE = 50

type RangePreset = '24h' | '7d' | '30d' | 'custom'

const RANGE_LABELS: Record<RangePreset, string> = {
  '24h': 'Last 24h',
  '7d': 'Last 7d',
  '30d': 'Last 30d',
  custom: 'Custom',
}

function presetSince(preset: Exclude<RangePreset, 'custom'>): Date {
  const now = Date.now()
  const ms = preset === '24h' ? 24 * 3600_000 : preset === '7d' ? 7 * 86_400_000 : 30 * 86_400_000
  return new Date(now - ms)
}

function loadLastSeen(): number {
  const raw = localStorage.getItem(LAST_SEEN_KEY)
  const parsed = raw ? Number(raw) : 0
  return Number.isFinite(parsed) ? parsed : 0
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffMs = Date.now() - then
  const mins = Math.round(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return `${days}d ago`
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

function formatDayLabel(dateKey: string): string {
  const d = new Date(dateKey)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return `Today — ${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday — ${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

function dayKey(iso: string): string {
  const d = new Date(iso)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString()
}

export default function ReleasesTab() {
  const [events, setEvents] = useState<ReleaseEvent[]>([])
  const [pageMeta, setPageMeta] = useState<{ number: number; totalPages: number; totalElements: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [selectedServices, setSelectedServices] = useState<string[]>([])
  const [knownServices, setKnownServices] = useState<string[]>([])
  const [range, setRange] = useState<RangePreset>('7d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  // Captured once at mount, *before* "Mark all as read" can move it — this is
  // what drives the [NEW] chips and the "N new since your last visit" pill.
  const [lastSeenAt, setLastSeenAt] = useState<number>(() => loadLastSeen())

  const buildQuery = useCallback(
    (page: number) => {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('size', String(PAGE_SIZE))
      selectedServices.forEach((s) => params.append('service', s))
      if (range === 'custom') {
        if (customFrom) params.set('since', new Date(`${customFrom}T00:00:00`).toISOString())
        if (customTo) params.set('until', new Date(`${customTo}T23:59:59`).toISOString())
      } else {
        params.set('since', presetSince(range).toISOString())
      }
      return params.toString()
    },
    [selectedServices, range, customFrom, customTo],
  )

  const fetchPage = useCallback(
    async (page: number, replace: boolean) => {
      if (replace) {
        setLoading(true)
        setError(null)
      } else {
        setLoadingMore(true)
      }
      try {
        const data = await coordinatorGet<Page<ReleaseEvent>>(`/api/platform/releases?${buildQuery(page)}`)
        setEvents((prev) => (replace ? data.content : [...prev, ...data.content]))
        setPageMeta({ number: data.number, totalPages: data.totalPages, totalElements: data.totalElements })
        setKnownServices((prev) => {
          const merged = new Set(prev)
          data.content.forEach((e) => merged.add(e.service))
          return Array.from(merged).sort()
        })
      } catch (e) {
        const err = e as ApiError
        setError(
          err.status === 404
            ? 'Release-notes endpoint isn’t deployed yet on the coordinator — nothing to show.'
            : err.status === 403
              ? 'You don’t have permission to view releases.'
              : `Failed to load releases: ${err.message}`,
        )
        if (replace) {
          setEvents([])
          setPageMeta(null)
        }
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [buildQuery],
  )

  // Refetch from page 0 whenever filters change.
  useEffect(() => {
    fetchPage(0, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedServices, range, customFrom, customTo])

  const handleServiceChange = (e: SelectChangeEvent<string[]>) => {
    const value = e.target.value
    setSelectedServices(typeof value === 'string' ? value.split(',') : value)
  }

  const handleMarkAllRead = () => {
    const now = Date.now()
    localStorage.setItem(LAST_SEEN_KEY, String(now))
    setLastSeenAt(now)
  }

  const newCount = useMemo(
    () => events.filter((e) => new Date(e.deployedAt).getTime() > lastSeenAt).length,
    [events, lastSeenAt],
  )

  const grouped = useMemo(() => {
    const byDay = new Map<string, ReleaseEvent[]>()
    for (const e of events) {
      const key = dayKey(e.deployedAt)
      const list = byDay.get(key) ?? []
      list.push(e)
      byDay.set(key, list)
    }
    return Array.from(byDay.entries())
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([key, list]) => [key, list.sort((a, b) => (a.deployedAt < b.deployedAt ? 1 : -1))] as const)
  }, [events])

  const hasMore = pageMeta ? pageMeta.number + 1 < pageMeta.totalPages : false

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
      <Box sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <RocketLaunchIcon color="primary" />
        <Typography variant="h6" fontWeight={600}>Releases</Typography>
        {newCount > 0 && (
          <Chip label={`${newCount} new since your last visit`} size="small" color="primary" />
        )}
        <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
          What shipped, correlated from deploy events and merged PRs — no hand-written changelog.
        </Typography>
        <Button size="small" variant="outlined" onClick={handleMarkAllRead} disabled={newCount === 0}>
          Mark all as read
        </Button>
      </Box>

      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
          <FormControl size="small" sx={{ minWidth: 220 }}>
            <InputLabel id="releases-service-filter-label">Services</InputLabel>
            <Select
              labelId="releases-service-filter-label"
              multiple
              displayEmpty
              value={selectedServices}
              onChange={handleServiceChange}
              renderValue={(selected) => ((selected as string[]).length === 0 ? 'All services' : (selected as string[]).join(', '))}
              label="Services"
            >
              {knownServices.length === 0 && (
                <MenuItem disabled value="">
                  <em>No services seen yet</em>
                </MenuItem>
              )}
              {knownServices.map((s) => (
                <MenuItem key={s} value={s}>
                  <Checkbox checked={selectedServices.indexOf(s) > -1} size="small" />
                  <ListItemText primary={s} />
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <ToggleButtonGroup
            size="small"
            value={range}
            exclusive
            onChange={(_e, next: RangePreset | null) => {
              if (next) setRange(next)
            }}
          >
            {(Object.keys(RANGE_LABELS) as RangePreset[]).map((r) => (
              <ToggleButton key={r} value={r}>{RANGE_LABELS[r]}</ToggleButton>
            ))}
          </ToggleButtonGroup>

          {range === 'custom' && (
            <>
              <TextField
                label="From"
                type="date"
                size="small"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
              <TextField
                label="To"
                type="date"
                size="small"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
            </>
          )}
        </Stack>
      </Paper>

      {error && <Alert severity={error.startsWith('Release-notes') ? 'info' : 'error'} sx={{ mb: 2 }}>{error}</Alert>}

      {loading && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 4 }}>
          <CircularProgress size={20} />
          <Typography variant="body2" color="text.secondary">Loading releases…</Typography>
        </Box>
      )}

      {!loading && !error && events.length === 0 && (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            No releases in this window. Try widening the date range or clearing the service filter.
          </Typography>
        </Paper>
      )}

      {!loading && grouped.map(([key, dayEvents]) => (
        <Box key={key} sx={{ mb: 3 }}>
          <Typography
            variant="overline"
            sx={{ color: 'text.secondary', fontWeight: 700, letterSpacing: 1 }}
          >
            {formatDayLabel(key)}
          </Typography>
          <Divider sx={{ mb: 1.5 }} />
          <Stack spacing={1.5}>
            {dayEvents.map((event) => {
              const isNew = new Date(event.deployedAt).getTime() > lastSeenAt
              return (
                <Paper key={event.id} variant="outlined" sx={{ p: 2 }}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography variant="subtitle2" fontWeight={700}>{event.service}</Typography>
                    <Chip label={event.revision} size="small" variant="outlined" />
                    <Typography variant="caption" color="text.secondary">
                      {formatTime(event.deployedAt)} · deployed {formatRelative(event.deployedAt)}
                    </Typography>
                    {isNew && <Chip label="NEW" size="small" color="success" />}
                    <Box sx={{ flexGrow: 1 }} />
                    {event.source !== 'agent' && (
                      <Chip label={event.source} size="small" variant="outlined" sx={{ opacity: 0.7 }} />
                    )}
                  </Stack>

                  {event.prs.length > 0 ? (
                    <Box sx={{ mt: 1 }}>
                      <Typography variant="caption" color="text.secondary">
                        {event.prs.length} PR{event.prs.length === 1 ? '' : 's'}
                        {event.priorRevision ? ` since ${event.priorRevision}` : ''}
                      </Typography>
                      <Stack spacing={0.5} sx={{ mt: 0.5, pl: 1 }}>
                        {event.prs.map((pr) => (
                          <Box key={pr.number} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <MuiLink
                              href={pr.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              variant="body2"
                              sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}
                            >
                              #{pr.number} {pr.title}
                              <OpenInNewIcon sx={{ fontSize: 13 }} />
                            </MuiLink>
                            {pr.author && (
                              <Typography variant="caption" color="text.secondary">
                                @{pr.author}
                              </Typography>
                            )}
                          </Box>
                        ))}
                      </Stack>
                    </Box>
                  ) : (
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                      No PRs recorded for this deploy (service not mapped, or nothing merged since the prior revision).
                    </Typography>
                  )}

                  {event.notes && (
                    <Typography variant="body2" sx={{ mt: 1 }}>{event.notes}</Typography>
                  )}
                </Paper>
              )
            })}
          </Stack>
        </Box>
      ))}

      {!loading && hasMore && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1, mb: 2 }}>
          <Button
            variant="outlined"
            size="small"
            onClick={() => fetchPage((pageMeta?.number ?? 0) + 1, false)}
            disabled={loadingMore}
            startIcon={loadingMore ? <CircularProgress size={14} /> : undefined}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </Box>
      )}
    </motion.div>
  )
}
