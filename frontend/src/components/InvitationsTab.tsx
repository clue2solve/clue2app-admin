import { useCallback, useEffect, useState } from 'react'
import {
  Box,
  Typography,
  Paper,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableContainer,
  TablePagination,
  Chip,
  Button,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  IconButton,
  CircularProgress,
  Alert,
  Tooltip,
  Stack,
  ToggleButtonGroup,
  ToggleButton,
  Divider,
} from '@mui/material'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import CloseIcon from '@mui/icons-material/Close'
import { motion } from 'framer-motion'
import { coordinatorGet, coordinatorPost, ApiError } from '../api'

interface InvitationRecord {
  id: string
  requestId: string | null
  email: string | null
  projectName: string | null
  kind: 'SOLO' | 'TRIAL_ACCOUNT' | 'BILLING_ACCOUNT' | null
  accountName: string | null
  maxProjects: number | null
  billingInfoCaptured: boolean | null
  status: string | null
  trialStartOn: string | null
  trialEndOn: string | null
  expiresOn: string | null
  issuedOn: string | null
  redeemedOn: string | null
}

interface InviteResult {
  invitation: InvitationRecord
  code: string
  redemptionUrl: string
}

interface Page<T> {
  content: T[]
  totalElements: number
  totalPages: number
  number: number
  size: number
}

const STATUS_FILTERS = ['ALL', 'ISSUED', 'REDEEMED', 'EXPIRED', 'REVOKED'] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

const INVITE_TYPES = [
  { value: 'SOLO', label: 'Solo trial' },
  { value: 'TRIAL_ACCOUNT', label: 'Trial account' },
  { value: 'BILLING_ACCOUNT', label: 'Billing account' },
] as const
type InviteType = (typeof INVITE_TYPES)[number]['value']

const KIND_CHIP: Record<string, { label: string; color: 'default' | 'primary' | 'success' }> = {
  SOLO: { label: 'SOLO', color: 'default' },
  TRIAL_ACCOUNT: { label: 'TRIAL-ACCT', color: 'primary' },
  BILLING_ACCOUNT: { label: 'BILLING-ACCT', color: 'success' },
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function statusColor(status: string | null): 'default' | 'success' | 'warning' | 'error' {
  switch (status) {
    case 'ISSUED':
      return 'warning'
    case 'REDEEMED':
      return 'success'
    case 'EXPIRED':
    case 'REVOKED':
      return 'error'
    default:
      return 'default'
  }
}

const POLL_INTERVAL_MS = 60_000

export default function InvitationsTab() {
  // ---- invite type ----
  const [inviteType, setInviteType] = useState<InviteType>('SOLO')

  // ---- shared form state ----
  const [email, setEmail] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // ---- SOLO-only ----
  const [projectName, setProjectName] = useState('')
  const [trialLengthDaysSolo, setTrialLengthDaysSolo] = useState('14')

  // ---- TRIAL_ACCOUNT / BILLING_ACCOUNT shared ----
  const [accountName, setAccountName] = useState('')
  const [maxProjects, setMaxProjects] = useState('3')

  // ---- TRIAL_ACCOUNT-only ----
  const [trialLengthDaysAccount, setTrialLengthDaysAccount] = useState('30')

  // ---- BILLING_ACCOUNT-only (billing info block) ----
  const [billingContactName, setBillingContactName] = useState('')
  const [billingContactEmail, setBillingContactEmail] = useState('')
  const [billingAddressLine1, setBillingAddressLine1] = useState('')
  const [billingAddressCity, setBillingAddressCity] = useState('')
  const [billingAddressRegion, setBillingAddressRegion] = useState('')
  const [billingAddressPostalCode, setBillingAddressPostalCode] = useState('')
  const [billingAddressCountry, setBillingAddressCountry] = useState('US')
  const [taxId, setTaxId] = useState('')
  const [poNumber, setPoNumber] = useState('')

  // ---- result dialog ----
  const [result, setResult] = useState<InviteResult | null>(null)
  const [copied, setCopied] = useState(false)

  // ---- list state ----
  const [page, setPage] = useState(0)
  const [rowsPerPage, setRowsPerPage] = useState(10)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL')
  const [invitations, setInvitations] = useState<Page<InvitationRecord> | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const loadInvitations = useCallback(() => {
    const statusParam = statusFilter === 'ALL' ? '' : `&status=${statusFilter}`
    coordinatorGet<Page<InvitationRecord>>(
      `/api/v1/invitations?page=${page}&size=${rowsPerPage}${statusParam}`,
    )
      .then((data) => setInvitations(data))
      .catch((e: ApiError) => {
        setListError(
          e.status === 403
            ? 'SYSTEM privileges required to view invitations.'
            : `Failed to load invitations: ${e.message}`,
        )
      })
  }, [page, rowsPerPage, statusFilter])

  useEffect(() => {
    loadInvitations()
    const t = setInterval(loadInvitations, POLL_INTERVAL_MS)
    return () => clearInterval(t)
  }, [loadInvitations])

  const resetForm = () => {
    setEmail('')
    setNotes('')
    setProjectName('')
    setTrialLengthDaysSolo('14')
    setAccountName('')
    setMaxProjects('3')
    setTrialLengthDaysAccount('30')
    setBillingContactName('')
    setBillingContactEmail('')
    setBillingAddressLine1('')
    setBillingAddressCity('')
    setBillingAddressRegion('')
    setBillingAddressPostalCode('')
    setBillingAddressCountry('US')
    setTaxId('')
    setPoNumber('')
  }

  const handleSubmit = async () => {
    setFormError(null)
    if (!email.trim()) {
      setFormError('Email is required.')
      return
    }

    if (inviteType === 'SOLO') {
      const days = trialLengthDaysSolo.trim() === '' ? undefined : parseInt(trialLengthDaysSolo, 10)
      if (days !== undefined && (Number.isNaN(days) || days <= 0)) {
        setFormError('Trial length must be a positive number of days.')
        return
      }
      setSubmitting(true)
      try {
        const res = await coordinatorPost<InviteResult>('/api/v1/invitations/solo', {
          email: email.trim(),
          projectName: projectName.trim() || undefined,
          trialLengthDays: days,
          notes: notes.trim() || undefined,
        })
        setResult(res)
        resetForm()
        loadInvitations()
      } catch (e) {
        setFormError((e as ApiError).message || 'Failed to create invitation.')
      } finally {
        setSubmitting(false)
      }
      return
    }

    if (inviteType === 'TRIAL_ACCOUNT') {
      if (!accountName.trim()) {
        setFormError('Account name is required.')
        return
      }
      const days = parseInt(trialLengthDaysAccount, 10)
      if (Number.isNaN(days) || days <= 0) {
        setFormError('Trial length must be a positive number of days.')
        return
      }
      const projects = parseInt(maxProjects, 10)
      if (Number.isNaN(projects) || projects <= 0) {
        setFormError('Max projects must be a positive number.')
        return
      }
      setSubmitting(true)
      try {
        const res = await coordinatorPost<InviteResult>('/api/v1/invitations/trial-account', {
          email: email.trim(),
          accountName: accountName.trim(),
          trialLengthDays: days,
          maxProjects: projects,
          notes: notes.trim() || undefined,
        })
        setResult(res)
        resetForm()
        loadInvitations()
      } catch (e) {
        setFormError((e as ApiError).message || 'Failed to create invitation.')
      } finally {
        setSubmitting(false)
      }
      return
    }

    // BILLING_ACCOUNT
    if (!accountName.trim()) {
      setFormError('Account name is required.')
      return
    }
    if (!billingContactName.trim() || !billingContactEmail.trim()) {
      setFormError('Billing contact name and email are required.')
      return
    }
    if (!billingAddressLine1.trim() || !billingAddressCity.trim() || !billingAddressCountry.trim()) {
      setFormError('Billing address (line 1, city, country) is required.')
      return
    }
    const projects = parseInt(maxProjects, 10)
    if (Number.isNaN(projects) || projects <= 0) {
      setFormError('Max projects must be a positive number.')
      return
    }
    setSubmitting(true)
    try {
      const res = await coordinatorPost<InviteResult>('/api/v1/invitations/billing-account', {
        email: email.trim(),
        accountName: accountName.trim(),
        maxProjects: projects,
        billingContactName: billingContactName.trim(),
        billingContactEmail: billingContactEmail.trim(),
        billingAddress: {
          line1: billingAddressLine1.trim(),
          city: billingAddressCity.trim(),
          region: billingAddressRegion.trim() || undefined,
          postalCode: billingAddressPostalCode.trim() || undefined,
          country: billingAddressCountry.trim(),
        },
        taxId: taxId.trim() || undefined,
        poNumber: poNumber.trim() || undefined,
        paymentMethodId: null,
        notes: notes.trim() || undefined,
      })
      setResult(res)
      resetForm()
      loadInvitations()
    } catch (e) {
      setFormError((e as ApiError).message || 'Failed to create invitation.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRevoke = async (id: string) => {
    setRevokingId(id)
    try {
      await coordinatorPost(`/api/v1/invitations/${id}/revoke`)
      loadInvitations()
    } catch (e) {
      const err = e as ApiError
      setListError(err.message || 'Failed to revoke invitation.')
    } finally {
      setRevokingId(null)
    }
  }

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API unavailable — nothing more we can do silently.
    }
  }

  const rows = invitations?.content ?? []

  const formHint =
    inviteType === 'SOLO'
      ? 'Invite a single-project trial user. No email is sent — copy the redemption link and hand it to the invitee manually.'
      : inviteType === 'TRIAL_ACCOUNT'
        ? 'Invite an account admin who can create multiple projects under a trial account. No project is created up front — the invitee names their first project after redeeming.'
        : 'Invite an account admin whose account starts directly on BILLING (no trial dates). Billing contact and address are required and stored for invoicing; card capture is a placeholder until Stripe (Phase-2) is wired in.'

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
    >
      <Box sx={{ mb: 2 }}>
        <Typography variant="h6" fontWeight={600}>Invitations</Typography>
        <Typography variant="body2" color="text.secondary">
          Issue one-shot redemption links for new users. Choose an invite type below.
        </Typography>
      </Box>

      <Paper variant="outlined" sx={{ p: 3, mb: 3, maxWidth: 640 }}>
        <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 2 }}>
          New invitation
        </Typography>

        <ToggleButtonGroup
          size="small"
          value={inviteType}
          exclusive
          onChange={(_e, next) => {
            if (next) {
              setInviteType(next)
              setFormError(null)
            }
          }}
          sx={{ mb: 2 }}
        >
          {INVITE_TYPES.map((t) => (
            <ToggleButton key={t.value} value={t.value}>
              {t.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {formHint}
        </Typography>

        <Stack spacing={2}>
          <TextField
            label="Invitee email"
            size="small"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
          />

          {inviteType === 'SOLO' && (
            <>
              <TextField
                label="Project name"
                size="small"
                placeholder="Defaults to a name derived from the email"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
              />
              <TextField
                label="Trial length (days)"
                size="small"
                type="number"
                value={trialLengthDaysSolo}
                onChange={(e) => setTrialLengthDaysSolo(e.target.value)}
                inputProps={{ min: 1 }}
              />
            </>
          )}

          {(inviteType === 'TRIAL_ACCOUNT' || inviteType === 'BILLING_ACCOUNT') && (
            <>
              <TextField
                label="Account name"
                size="small"
                required
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
              />
              <TextField
                label="Max projects"
                size="small"
                type="number"
                value={maxProjects}
                onChange={(e) => setMaxProjects(e.target.value)}
                inputProps={{ min: 1 }}
              />
            </>
          )}

          {inviteType === 'TRIAL_ACCOUNT' && (
            <TextField
              label="Trial length (days)"
              size="small"
              type="number"
              value={trialLengthDaysAccount}
              onChange={(e) => setTrialLengthDaysAccount(e.target.value)}
              inputProps={{ min: 1 }}
            />
          )}

          {inviteType === 'BILLING_ACCOUNT' && (
            <>
              <Divider textAlign="left">
                <Typography variant="caption" color="text.secondary">Billing contact</Typography>
              </Divider>
              <TextField
                label="Billing contact name"
                size="small"
                required
                value={billingContactName}
                onChange={(e) => setBillingContactName(e.target.value)}
              />
              <TextField
                label="Billing contact email"
                size="small"
                required
                type="email"
                value={billingContactEmail}
                onChange={(e) => setBillingContactEmail(e.target.value)}
              />
              <Divider textAlign="left">
                <Typography variant="caption" color="text.secondary">Billing address</Typography>
              </Divider>
              <TextField
                label="Address line 1"
                size="small"
                required
                value={billingAddressLine1}
                onChange={(e) => setBillingAddressLine1(e.target.value)}
              />
              <Stack direction="row" spacing={2}>
                <TextField
                  label="City"
                  size="small"
                  required
                  fullWidth
                  value={billingAddressCity}
                  onChange={(e) => setBillingAddressCity(e.target.value)}
                />
                <TextField
                  label="Region / State"
                  size="small"
                  fullWidth
                  value={billingAddressRegion}
                  onChange={(e) => setBillingAddressRegion(e.target.value)}
                />
              </Stack>
              <Stack direction="row" spacing={2}>
                <TextField
                  label="Postal code"
                  size="small"
                  fullWidth
                  value={billingAddressPostalCode}
                  onChange={(e) => setBillingAddressPostalCode(e.target.value)}
                />
                <TextField
                  label="Country"
                  size="small"
                  required
                  fullWidth
                  value={billingAddressCountry}
                  onChange={(e) => setBillingAddressCountry(e.target.value)}
                />
              </Stack>
              <Stack direction="row" spacing={2}>
                <TextField
                  label="Tax ID"
                  size="small"
                  fullWidth
                  value={taxId}
                  onChange={(e) => setTaxId(e.target.value)}
                />
                <TextField
                  label="PO number"
                  size="small"
                  fullWidth
                  value={poNumber}
                  onChange={(e) => setPoNumber(e.target.value)}
                />
              </Stack>
              <TextField
                label="Payment method"
                size="small"
                disabled
                placeholder="Stripe card capture — coming in Phase 2"
                helperText="Not collected yet. Billing starts on invoice/PO until Stripe is wired in."
              />
            </>
          )}

          <TextField
            label="Notes"
            size="small"
            placeholder="Optional — why is this person here?"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            multiline
            minRows={2}
          />
          {formError && <Alert severity="error">{formError}</Alert>}
          <Box>
            <Button
              variant="contained"
              onClick={handleSubmit}
              disabled={submitting}
              startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : undefined}
            >
              {submitting ? 'Creating…' : 'Create invitation'}
            </Button>
          </Box>
        </Stack>
      </Paper>

      <Box sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="subtitle1" fontWeight={600} sx={{ mr: 1 }}>
          Invitations
        </Typography>
        {STATUS_FILTERS.map((s) => (
          <Chip
            key={s}
            label={s}
            size="small"
            color={s === statusFilter ? 'primary' : 'default'}
            variant={s === statusFilter ? 'filled' : 'outlined'}
            onClick={() => {
              setStatusFilter(s)
              setPage(0)
            }}
          />
        ))}
      </Box>

      {listError && <Alert severity="error" sx={{ mb: 2 }}>{listError}</Alert>}

      {!invitations && !listError && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 4 }}>
          <CircularProgress size={20} />
          <Typography variant="body2" color="text.secondary">Loading invitations…</Typography>
        </Box>
      )}

      {invitations && (
        <>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Email</TableCell>
                  <TableCell>Kind</TableCell>
                  <TableCell>Project / Account</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Trial ends</TableCell>
                  <TableCell>Issued</TableCell>
                  <TableCell>Expires</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} align="center">
                      <Typography variant="body2" color="text.secondary" sx={{ py: 3 }}>
                        No invitations{statusFilter !== 'ALL' ? ` with status ${statusFilter}` : ''}.
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((inv) => {
                  const kind = KIND_CHIP[inv.kind || 'SOLO'] || KIND_CHIP.SOLO
                  return (
                    <TableRow key={inv.id} hover>
                      <TableCell>{inv.email || '—'}</TableCell>
                      <TableCell>
                        <Chip label={kind.label} size="small" color={kind.color} variant="outlined" />
                      </TableCell>
                      <TableCell>
                        {inv.kind === 'SOLO' ? (inv.projectName || '—') : (inv.accountName || '—')}
                        {inv.maxProjects != null && (
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                            max {inv.maxProjects} projects
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={inv.status || 'UNKNOWN'}
                          size="small"
                          color={statusColor(inv.status)}
                          variant="outlined"
                        />
                      </TableCell>
                      <TableCell>{inv.kind === 'BILLING_ACCOUNT' ? '—' : formatDate(inv.trialEndOn)}</TableCell>
                      <TableCell>{formatDate(inv.issuedOn)}</TableCell>
                      <TableCell>{formatDate(inv.expiresOn)}</TableCell>
                      <TableCell align="right">
                        <Stack direction="row" spacing={1} justifyContent="flex-end">
                          <Tooltip title="Revoke">
                            <span>
                              <Button
                                size="small"
                                color="error"
                                variant="outlined"
                                disabled={inv.status !== 'ISSUED' || revokingId === inv.id}
                                onClick={() => handleRevoke(inv.id)}
                              >
                                {revokingId === inv.id ? '…' : 'Revoke'}
                              </Button>
                            </span>
                          </Tooltip>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </TableContainer>

          <TablePagination
            component="div"
            count={invitations.totalElements}
            page={page}
            onPageChange={(_e, newPage) => setPage(newPage)}
            rowsPerPage={rowsPerPage}
            onRowsPerPageChange={(e) => {
              setRowsPerPage(parseInt(e.target.value, 10))
              setPage(0)
            }}
            rowsPerPageOptions={[10, 25, 50]}
          />
        </>
      )}

      <Dialog open={!!result} onClose={() => setResult(null)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Invitation created
          <IconButton size="small" onClick={() => setResult(null)}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Copy this link and send it to <strong>{result?.invitation.email}</strong> manually —
            no email is sent automatically. The token is shown once and cannot be retrieved again.
          </Typography>
          <TextField
            fullWidth
            size="small"
            value={result?.redemptionUrl ?? ''}
            InputProps={{
              readOnly: true,
              endAdornment: (
                <IconButton
                  size="small"
                  onClick={() => result && copyToClipboard(result.redemptionUrl)}
                  title="Copy link"
                >
                  <ContentCopyIcon fontSize="small" />
                </IconButton>
              ),
            }}
          />
          {copied && (
            <Typography variant="caption" color="success.main" sx={{ display: 'block', mt: 1 }}>
              Copied to clipboard.
            </Typography>
          )}
          {result?.invitation.trialEndOn && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
              Trial ends {formatDate(result.invitation.trialEndOn)}.
            </Typography>
          )}
          {result?.invitation.billingInfoCaptured && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
              Billing contact captured — account starts on BILLING immediately upon redemption.
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResult(null)}>Done</Button>
        </DialogActions>
      </Dialog>
    </motion.div>
  )
}
