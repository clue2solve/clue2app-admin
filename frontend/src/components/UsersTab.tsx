import { useEffect, useState } from 'react'
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
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import { motion } from 'framer-motion'
import { coordinatorGet, ApiError } from '../api'

interface User {
  id: string
  name: string
  email: string | null
  userType: 'SYSTEM' | 'USER'
  accountId: string | null
  accountName: string | null
  enabled: boolean | null
  createdOn: string | null
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}

type StatusFilter = 'active' | 'all'

export default function UsersTab() {
  const [users, setUsers] = useState<User[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  // Default to active-only: disabled accounts are cleanup residue and shouldn't
  // clutter the everyday admin view. Explicit toggle to show them all.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active')

  useEffect(() => {
    let cancelled = false
    coordinatorGet<User[]>('/api/users')
      .then((data) => { if (!cancelled) setUsers(data) })
      .catch((e: ApiError) => {
        if (cancelled) return
        setErr(e.status === 403
          ? 'SYSTEM privileges required to view all users.'
          : `Failed to load users: ${e.message}`)
      })
    return () => { cancelled = true }
  }, [])

  const filtered = users?.filter((u) => {
    // Status filter first (cheap boolean check)
    if (statusFilter === 'active' && u.enabled === false) return false
    // Then text search
    if (!q) return true
    const needle = q.toLowerCase()
    return (u.name ?? '').toLowerCase().includes(needle)
      || (u.email ?? '').toLowerCase().includes(needle)
      || u.id.toLowerCase().includes(needle)
  }) ?? []

  const disabledCount = users?.filter((u) => u.enabled === false).length ?? 0

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
    >
      <Box sx={{ mb: 2, display: 'flex', alignItems: 'baseline', gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h6" fontWeight={600}>Users</Typography>
        <Typography variant="body2" color="text.secondary">
          Cross-tenant list of users on the platform. Read-only — no group/role membership shown here (would N+1).
        </Typography>
      </Box>

      {err && <Alert severity="error" sx={{ mb: 2 }}>{err}</Alert>}

      {!users && !err && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 4 }}>
          <CircularProgress size={20} />
          <Typography variant="body2" color="text.secondary">Loading users…</Typography>
        </Box>
      )}

      {users && (
        <>
          <Box sx={{ mb: 2, display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
            <TextField
              size="small"
              placeholder="Filter by name, email, or id"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              sx={{ maxWidth: 360, flex: '1 1 320px' }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              }}
            />
            <ToggleButtonGroup
              size="small"
              value={statusFilter}
              exclusive
              onChange={(_, v) => v && setStatusFilter(v)}
              aria-label="user status filter"
            >
              <ToggleButton value="active" aria-label="active only">
                Active
              </ToggleButton>
              <ToggleButton value="all" aria-label="show all including disabled">
                All {disabledCount > 0 && `(+${disabledCount} disabled)`}
              </ToggleButton>
            </ToggleButtonGroup>
          </Box>

          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Email</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Account</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace' }}>ID</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} align="center">
                      <Typography variant="body2" color="text.secondary" sx={{ py: 3 }}>
                        {q ? 'No users match.' : 'No users.'}
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
                {filtered.map((u) => (
                  <TableRow key={u.id} hover>
                    <TableCell>
                      <Typography variant="body2" fontWeight={500}>{u.name || '—'}</Typography>
                    </TableCell>
                    <TableCell>{u.email || '—'}</TableCell>
                    <TableCell>
                      <Chip
                        label={u.userType}
                        size="small"
                        color={u.userType === 'SYSTEM' ? 'secondary' : 'default'}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>{u.accountName || '—'}</TableCell>
                    <TableCell>
                      <Chip
                        label={u.enabled === false ? 'Disabled' : 'Active'}
                        size="small"
                        color={u.enabled === false ? 'default' : 'success'}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>{formatDate(u.createdOn)}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'text.secondary' }}>
                      {u.id}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            {filtered.length} of {users.length} user{users.length === 1 ? '' : 's'}
          </Typography>
        </>
      )}
    </motion.div>
  )
}
