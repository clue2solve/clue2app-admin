import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  Link,
  Radio,
  RadioGroup,
  Stack,
  Step,
  StepLabel,
  Stepper,
  TextField,
  Typography,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import { ApiError, coordinatorPost } from '../api'

// ---------------------------------------------------------------------------
// NewAccountWizard — SCK-621 (Layer 2b).
//
// SYSTEM-only bootstrap wizard for provisioning a brand-new account +
// minting its first ACCOUNT_ADMIN invitation in a single flow. Wraps the
// SCK-620 backend endpoint POST /api/v1/invitations/account-admin.
//
// Kept as a self-contained modal so OrgsTab (and future call sites) only
// need `<NewAccountWizard open onClose onCreated />`.
// ---------------------------------------------------------------------------

const STEPS = ['Account details', 'First ACCOUNT_ADMIN invite'] as const

const DEFAULT_MAX_PROJECTS = 5
const DEFAULT_TRIAL_LENGTH_DAYS = 14

const MIN_ACCOUNT_NAME = 3
const MAX_PROJECTS_UPPER = 100
const TRIAL_DAYS_UPPER = 90

// Loose but useful: the server is the source of truth. This matches the
// same shape used by the console.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type DeliveryMode = 'email' | 'copy_only'

interface BillingInfo {
  stripeCustomerId?: string
  contactEmail?: string
  notes?: string
}

// Server response envelope — mirrors the SCK-620 endpoint contract.
export interface AccountAdminInvitationResult {
  invitation: {
    id: string
    email: string | null
    accountName: string | null
    redemptionUrl: string
    // Server returns `expires_on` (snake) per the SCK-620 spec but many
    // sibling endpoints return `expiresOn` (camel). Accept either.
    expires_on?: string | null
    expiresOn?: string | null
    trialEndOn?: string | null
    billingInfoCaptured?: boolean | null
    deliveryMode?: DeliveryMode | null
    sesEnabled?: boolean | null
  }
  // Some deployments include the raw redemption code alongside the URL.
  code?: string
}

// Per-field error map returned by 400 responses.
type FieldErrors = Partial<Record<
  'accountName' | 'maxProjects' | 'trialLengthDays' | 'email' | 'billingInfo' | 'deliveryMode',
  string
>>

interface NewAccountWizardProps {
  open: boolean
  onClose: () => void
  onCreated: (result: AccountAdminInvitationResult) => void
}

export default function NewAccountWizard({ open, onClose, onCreated }: NewAccountWizardProps) {
  // ---- stepper ----
  const [activeStep, setActiveStep] = useState<0 | 1>(0)

  // ---- step 1 fields ----
  const [accountName, setAccountName] = useState('')
  const [maxProjects, setMaxProjects] = useState(String(DEFAULT_MAX_PROJECTS))
  const [trialLengthDays, setTrialLengthDays] = useState(String(DEFAULT_TRIAL_LENGTH_DAYS))
  const [billingExpanded, setBillingExpanded] = useState(false)
  const [billingStripeCustomerId, setBillingStripeCustomerId] = useState('')
  const [billingContactEmail, setBillingContactEmail] = useState('')
  const [billingNotes, setBillingNotes] = useState('')

  // ---- step 2 fields ----
  const [email, setEmail] = useState('')
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>('email')
  const [notes, setNotes] = useState('')

  // ---- feedback ----
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<AccountAdminInvitationResult | null>(null)
  const [copied, setCopied] = useState(false)

  // Derived: is any billing field present? Marks the payload as
  // billing-prefilled so the coordinator can route accordingly.
  const billingInfoPayload = useMemo<BillingInfo | undefined>(() => {
    const stripe = billingStripeCustomerId.trim()
    const contact = billingContactEmail.trim()
    const bn = billingNotes.trim()
    if (!stripe && !contact && !bn) return undefined
    return {
      stripeCustomerId: stripe || undefined,
      contactEmail: contact || undefined,
      notes: bn || undefined,
    }
  }, [billingStripeCustomerId, billingContactEmail, billingNotes])

  const resetAll = () => {
    setActiveStep(0)
    setAccountName('')
    setMaxProjects(String(DEFAULT_MAX_PROJECTS))
    setTrialLengthDays(String(DEFAULT_TRIAL_LENGTH_DAYS))
    setBillingExpanded(false)
    setBillingStripeCustomerId('')
    setBillingContactEmail('')
    setBillingNotes('')
    setEmail('')
    setDeliveryMode('email')
    setNotes('')
    setFieldErrors({})
    setFormError(null)
    setResult(null)
    setCopied(false)
  }

  const handleClose = () => {
    if (submitting) return
    resetAll()
    onClose()
  }

  const handleDone = () => {
    // If we have a result, tell the caller so it can refresh, THEN close.
    const r = result
    resetAll()
    onClose()
    if (r) onCreated(r)
  }

  // ---- validation ------------------------------------------------------

  const validateStep1 = (): FieldErrors => {
    const errs: FieldErrors = {}
    const trimmed = accountName.trim()
    if (trimmed.length < MIN_ACCOUNT_NAME) {
      errs.accountName = `Account name must be at least ${MIN_ACCOUNT_NAME} characters.`
    }
    const mp = parseInt(maxProjects, 10)
    if (Number.isNaN(mp) || mp < 1 || mp > MAX_PROJECTS_UPPER) {
      errs.maxProjects = `Must be a whole number between 1 and ${MAX_PROJECTS_UPPER}.`
    }
    const td = parseInt(trialLengthDays, 10)
    if (Number.isNaN(td) || td < 1 || td > TRIAL_DAYS_UPPER) {
      errs.trialLengthDays = `Must be a whole number between 1 and ${TRIAL_DAYS_UPPER}.`
    }
    // billing block: if any field present and contact email present, it must
    // parse as an email. (Stripe id + notes are freeform.)
    const bcEmail = billingContactEmail.trim()
    if (bcEmail && !EMAIL_RE.test(bcEmail)) {
      errs.billingInfo = 'Billing contact email is not a valid email address.'
    }
    return errs
  }

  const validateStep2 = (): FieldErrors => {
    const errs: FieldErrors = {}
    const trimmed = email.trim()
    if (!trimmed) {
      errs.email = 'Email is required.'
    } else if (!EMAIL_RE.test(trimmed)) {
      errs.email = 'Enter a valid email address.'
    }
    return errs
  }

  const handleNext = () => {
    const errs = validateStep1()
    if (Object.keys(errs).length) {
      setFieldErrors(errs)
      return
    }
    setFieldErrors({})
    setFormError(null)
    setActiveStep(1)
  }

  const handleBack = () => {
    setFieldErrors({})
    setFormError(null)
    setActiveStep(0)
  }

  // ---- submit ----------------------------------------------------------

  const handleSubmit = async () => {
    const errs = validateStep2()
    if (Object.keys(errs).length) {
      setFieldErrors(errs)
      return
    }
    setFieldErrors({})
    setFormError(null)
    setSubmitting(true)

    const payload: Record<string, unknown> = {
      email: email.trim(),
      accountName: accountName.trim(),
      trialLengthDays: parseInt(trialLengthDays, 10),
      maxProjects: parseInt(maxProjects, 10),
      deliveryMode,
    }
    if (billingInfoPayload) payload.billingInfo = billingInfoPayload
    const trimmedNotes = notes.trim()
    if (trimmedNotes) payload.notes = trimmedNotes

    try {
      const res = await coordinatorPost<AccountAdminInvitationResult>(
        '/api/v1/invitations/account-admin',
        payload,
      )
      setResult(res)
    } catch (e) {
      const err = e as ApiError
      if (err.status === 400) {
        // Best-effort: surface server-side field errors under their inputs.
        const body = err.body as { fieldErrors?: Record<string, string>; message?: string } | null
        const serverFields = body?.fieldErrors || {}
        const mapped: FieldErrors = {}
        for (const [k, v] of Object.entries(serverFields)) {
          if (
            k === 'accountName' ||
            k === 'maxProjects' ||
            k === 'trialLengthDays' ||
            k === 'email' ||
            k === 'billingInfo' ||
            k === 'deliveryMode'
          ) {
            mapped[k] = v
          }
        }
        if (Object.keys(mapped).length) {
          setFieldErrors(mapped)
          // If any field belongs to step 1, jump back so it's visible.
          if (
            mapped.accountName || mapped.maxProjects ||
            mapped.trialLengthDays || mapped.billingInfo
          ) {
            setActiveStep(0)
          }
        } else {
          setFormError(body?.message || err.message || 'Invalid request.')
        }
      } else if (err.status === 403) {
        setFormError('Only SYSTEM users can bootstrap accounts.')
      } else if (err.status >= 500) {
        setFormError(
          `The server hit an error (${err.status}). Try again in a moment; if the problem persists, capture the details and ping platform.`,
        )
      } else {
        setFormError(err.message || 'Failed to create account.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleRetry = () => {
    setFormError(null)
    void handleSubmit()
  }

  const copyRedemptionUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API unavailable — nothing more we can do silently.
    }
  }

  // ---- render ----------------------------------------------------------

  // Result view. Show the redemption URL when either the operator chose
  // copy-only OR the server reports SES is disabled (so no email was sent).
  if (result) {
    const inv = result.invitation
    const expiresIso = inv.expires_on ?? inv.expiresOn ?? null
    const shouldShowUrl =
      inv.deliveryMode === 'copy_only' ||
      deliveryMode === 'copy_only' ||
      inv.sesEnabled === false
    return (
      <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Account created
          <IconButton size="small" onClick={handleDone}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <Alert severity="success" sx={{ mb: 2 }}>
            Account <strong>{inv.accountName || accountName}</strong> bootstrapped. Invitation sent
            to <strong>{inv.email || email}</strong>.
          </Alert>

          {shouldShowUrl && (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Copy this redemption link and send it manually — the token is shown once and
                cannot be retrieved again.
              </Typography>
              <TextField
                fullWidth
                size="small"
                value={inv.redemptionUrl}
                InputProps={{
                  readOnly: true,
                  endAdornment: (
                    <IconButton
                      size="small"
                      onClick={() => copyRedemptionUrl(inv.redemptionUrl)}
                      title="Copy link"
                      aria-label="Copy redemption link"
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
            </>
          )}

          {expiresIso && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
              Invitation expires {new Date(expiresIso).toLocaleString()}.
            </Typography>
          )}
          {inv.billingInfoCaptured && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              Billing info captured — account will start on BILLING once the invitation is redeemed.
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button variant="contained" onClick={handleDone}>Done</Button>
        </DialogActions>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        New account
        <IconButton size="small" onClick={handleClose} disabled={submitting}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <Stepper activeStep={activeStep} sx={{ mb: 3 }}>
          {STEPS.map((label) => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        {activeStep === 0 && (
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              Provision a new account. The first ACCOUNT_ADMIN is invited in the next step.
            </Typography>
            <TextField
              label="Account name"
              size="small"
              required
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              error={!!fieldErrors.accountName}
              helperText={fieldErrors.accountName || `At least ${MIN_ACCOUNT_NAME} characters.`}
              inputProps={{ 'aria-label': 'Account name' }}
            />
            <Stack direction="row" spacing={2}>
              <TextField
                label="Max projects"
                size="small"
                type="number"
                fullWidth
                required
                value={maxProjects}
                onChange={(e) => setMaxProjects(e.target.value)}
                error={!!fieldErrors.maxProjects}
                helperText={fieldErrors.maxProjects || `Default ${DEFAULT_MAX_PROJECTS}. 1–${MAX_PROJECTS_UPPER}.`}
                inputProps={{ min: 1, max: MAX_PROJECTS_UPPER, 'aria-label': 'Max projects' }}
              />
              <TextField
                label="Trial length (days)"
                size="small"
                type="number"
                fullWidth
                required
                value={trialLengthDays}
                onChange={(e) => setTrialLengthDays(e.target.value)}
                error={!!fieldErrors.trialLengthDays}
                helperText={fieldErrors.trialLengthDays || `Default ${DEFAULT_TRIAL_LENGTH_DAYS}. 1–${TRIAL_DAYS_UPPER}.`}
                inputProps={{ min: 1, max: TRIAL_DAYS_UPPER, 'aria-label': 'Trial length in days' }}
              />
            </Stack>

            <Box>
              <Link
                component="button"
                type="button"
                underline="hover"
                onClick={() => setBillingExpanded((v) => !v)}
                sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}
                aria-expanded={billingExpanded}
                aria-controls="billing-info-block"
              >
                {billingExpanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                Billing info (optional)
              </Link>
              <Collapse in={billingExpanded} unmountOnExit id="billing-info-block">
                <Stack spacing={2} sx={{ mt: 2 }}>
                  <Divider textAlign="left">
                    <Typography variant="caption" color="text.secondary">Billing prefill</Typography>
                  </Divider>
                  <Typography variant="caption" color="text.secondary">
                    Any field below marks the invitation as billing-prefilled. Leave the whole
                    block empty to keep the account on trial.
                  </Typography>
                  <TextField
                    label="Stripe customer ID"
                    size="small"
                    value={billingStripeCustomerId}
                    onChange={(e) => setBillingStripeCustomerId(e.target.value)}
                    placeholder="cus_..."
                  />
                  <TextField
                    label="Billing contact email"
                    size="small"
                    type="email"
                    value={billingContactEmail}
                    onChange={(e) => setBillingContactEmail(e.target.value)}
                    error={!!fieldErrors.billingInfo}
                    helperText={fieldErrors.billingInfo || ' '}
                  />
                  <TextField
                    label="Notes"
                    size="small"
                    multiline
                    minRows={2}
                    value={billingNotes}
                    onChange={(e) => setBillingNotes(e.target.value)}
                    placeholder="Freeform — invoicing terms, cost-center, contract link, etc."
                  />
                </Stack>
              </Collapse>
            </Box>

            {formError && <Alert severity="error">{formError}</Alert>}
          </Stack>
        )}

        {activeStep === 1 && (
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              Invite the first ACCOUNT_ADMIN for <strong>{accountName.trim()}</strong>.
            </Typography>
            <TextField
              label="Admin email"
              size="small"
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={!!fieldErrors.email}
              helperText={fieldErrors.email || 'They will receive the redemption link.'}
              inputProps={{ 'aria-label': 'Admin email' }}
            />

            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                Delivery
              </Typography>
              <RadioGroup
                row
                value={deliveryMode}
                onChange={(e) => setDeliveryMode(e.target.value as DeliveryMode)}
                aria-label="Delivery mode"
              >
                <FormControlLabel
                  value="email"
                  control={<Radio size="small" />}
                  label="Email the invitee"
                />
                <FormControlLabel
                  value="copy_only"
                  control={<Radio size="small" />}
                  label="Copy link only (no email)"
                />
              </RadioGroup>
            </Box>

            <TextField
              label="Notes"
              size="small"
              multiline
              minRows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional — internal context for who this is and why."
            />

            {formError && (
              <Alert
                severity="error"
                action={
                  formError.startsWith('The server hit an error') ? (
                    <Button color="inherit" size="small" onClick={handleRetry} disabled={submitting}>
                      Retry
                    </Button>
                  ) : undefined
                }
              >
                {formError}
              </Alert>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={submitting}>Cancel</Button>
        {activeStep === 1 && (
          <Button onClick={handleBack} disabled={submitting}>Back</Button>
        )}
        {activeStep === 0 && (
          <Button variant="contained" onClick={handleNext}>Next</Button>
        )}
        {activeStep === 1 && (
          <Button
            variant="contained"
            onClick={handleSubmit}
            disabled={submitting}
            startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {submitting ? 'Creating…' : 'Create account'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
