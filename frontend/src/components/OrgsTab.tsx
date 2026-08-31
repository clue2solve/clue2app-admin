import { useCallback, useEffect, useState } from 'react'
import {
  Box,
  Typography,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableContainer,
  Paper,
  Chip,
  CircularProgress,
  Alert,
  TextField,
  InputAdornment,
  Button,
  Link as MuiLink,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import LaunchIcon from '@mui/icons-material/Launch'
import { motion } from 'framer-motion'
import { coordinatorGet, ApiError } from '../api'

interface Org {
  id: string
  name: string
  enabled: boolean | null
  billingEnabled: boolean | null
  trialStartOn: string | null
  trialEndOn: string | null
  createdOn: string | null
}

const CONSOLE_ACCOUNTS_URL = 'https://console.clue2.app/directory/accounts'

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}

function trialStatus(o: Org): { label: string; color: 'default' | 'success' | 'warning' | 'error' } {
  if (o.billingEnabled) return { label: 'Billing', color: 'success' }
  const now = Date.now()
  const end = o.trialEndOn ? new Date(o.trialEndOn).getTime() : null
  if (end === null) return { label: 'No trial set', color: 'default' }
  if (now > end) return { label: 'Trial expired', color: 'error' }
  const daysLeft = Math.max(0, Math.ceil((end - now) / 86_400_000))
  return { label: `Trial · ${daysLeft}d left`, color: daysLeft <= 7 ? 'warning' : 'default' }
}

/**
 * OrgsTab — read-only after PR-2.
 *
 * The "+ New account" button and the NewAccountWizard were removed
 * here because account creation now lives on the main console at
 * /directory/accounts. This tab is preserved as a cross-tenant
 * lookup surface until the full admin-app retirement (much later).
 * Any operator hitting the visible banner is one click from the
 * canonical CTA.
 */
export default function OrgsTab() {
  const [orgs, setOrgs] = useState<Org[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')

  const loadOrgs = useCallback(() => {
    setErr(null)
    coordinatorGet<Org[]>('/api/accounts')
      .then((data) => setOrgs(data))
      .catch((e: ApiError) => {
        setErr(e.status === 403
          ? 'SYSTEM privileges required to view all orgs.'
          : `Failed to load orgs: ${e.message}`)
      })
  }, [])

  useEffect(() => {
    loadOrgs()
  }, [loadOrgs])

  const filtered = orgs?.filter((o) =>
    !q ||
    (o.name ?? '').toLowerCase().includes(q.toLowerCase()) ||
    o.id.toLowerCase().includes(q.toLowerCase())) ?? []

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
    >
      <Box sx={{ mb: 2, display: 'flex', alignItems: 'baseline', gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h6" fontWeight={600}>Orgs</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
          Cross-tenant list of accounts on the platform. Read-only in the admin app.
        </Typography>
        <Button
          component={MuiLink}
          href={CONSOLE_ACCOUNTS_URL}
          target="_blank"
          rel="noopener"
          variant="outlined"
          size="small"
          endIcon={<LaunchIcon />}
          sx={{ textTransform: 'none' }}
        >
          Open in Console
        </Button>
      </Box>

      <Alert severity="info" sx={{ mb: 2 }}>
        Account creation has moved to the main console —{' '}
        <MuiLink href={CONSOLE_ACCOUNTS_URL} target="_blank" rel="noopener">
          Directory → Accounts
        </MuiLink>
        . Use the New account wizard there to provision an account and
        mint its first ACCOUNT_ADMIN invitation.
      </Alert>

      {err && <Alert severity="error" sx={{ mb: 2 }}>{err}</Alert>}

      {!orgs && !err && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 4 }}>
          <CircularProgress size={20} />
          <Typography variant="body2" color="text.secondary">Loading orgs…</Typography>
        </Box>
      )}

      {orgs && (
        <>
          <TextField
            size="small"
            placeholder="Filter by name or id"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            sx={{ mb: 2, maxWidth: 360 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
          />

          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Trial ends</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace' }}>Account ID</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} align="center">
                      <Typography variant="body2" color="text.secondary" sx={{ py: 3 }}>
                        {q ? 'No orgs match.' : 'No orgs.'}
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
                {filtered.map((o) => {
                  const s = trialStatus(o)
                  return (
                    <TableRow key={o.id} hover>
                      <TableCell>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Typography variant="body2" fontWeight={500}>{o.name || '—'}</Typography>
                          {o.enabled === false && (
                            <Chip label="Disabled" size="small" color="default" />
                          )}
                        </Box>
                      </TableCell>
                      <TableCell>
                        <Chip label={s.label} size="small" color={s.color} variant="outlined" />
                      </TableCell>
                      <TableCell>{formatDate(o.trialEndOn)}</TableCell>
                      <TableCell>{formatDate(o.createdOn)}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'text.secondary' }}>
                        {o.id}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </TableContainer>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            {filtered.length} of {orgs.length} org{orgs.length === 1 ? '' : 's'}
          </Typography>
        </>
      )}
    </motion.div>
  )
}
