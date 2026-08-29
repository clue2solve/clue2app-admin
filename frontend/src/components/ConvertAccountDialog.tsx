import { useState } from 'react'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  IconButton,
  Typography,
  TextField,
  Stack,
  Divider,
  Button,
  Alert,
  CircularProgress,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import { coordinatorPut, ApiError } from '../api'

interface ConvertAccountResult {
  accountId: string
  previousKind: string
  kind: string
  trialEndOn: string | null
  billingStartedAt: string
  auditId: string
}

interface ConvertAccountDialogProps {
  open: boolean
  accountId: string | null
  accountName: string | null
  onClose: () => void
  onConverted: (result: ConvertAccountResult) => void
}

export default function ConvertAccountDialog({
  open,
  accountId,
  accountName,
  onClose,
  onConverted,
}: ConvertAccountDialogProps) {
  const [billingContactName, setBillingContactName] = useState('')
  const [billingContactEmail, setBillingContactEmail] = useState('')
  const [addressLine1, setAddressLine1] = useState('')
  const [addressCity, setAddressCity] = useState('')
  const [addressRegion, setAddressRegion] = useState('')
  const [addressPostalCode, setAddressPostalCode] = useState('')
  const [addressCountry, setAddressCountry] = useState('US')
  const [taxId, setTaxId] = useState('')
  const [poNumber, setPoNumber] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setBillingContactName('')
    setBillingContactEmail('')
    setAddressLine1('')
    setAddressCity('')
    setAddressRegion('')
    setAddressPostalCode('')
    setAddressCountry('US')
    setTaxId('')
    setPoNumber('')
    setReason('')
    setError(null)
  }

  const handleClose = () => {
    if (submitting) return
    reset()
    onClose()
  }

  const handleSubmit = async () => {
    setError(null)
    if (!accountId) return
    if (!billingContactName.trim() || !billingContactEmail.trim()) {
      setError('Billing contact name and email are required.')
      return
    }
    if (!addressLine1.trim() || !addressCity.trim() || !addressCountry.trim()) {
      setError('Billing address (line 1, city, country) is required.')
      return
    }
    setSubmitting(true)
    try {
      const res = await coordinatorPut<ConvertAccountResult>(
        `/api/v1/accounts/${accountId}/convert-to-billing`,
        {
          billingContactName: billingContactName.trim(),
          billingContactEmail: billingContactEmail.trim(),
          billingAddress: {
            line1: addressLine1.trim(),
            city: addressCity.trim(),
            region: addressRegion.trim() || undefined,
            postalCode: addressPostalCode.trim() || undefined,
            country: addressCountry.trim(),
          },
          taxId: taxId.trim() || undefined,
          paymentMethodId: null,
          poNumber: poNumber.trim() || undefined,
          reason: reason.trim() || undefined,
        },
      )
      reset()
      onConverted(res)
    } catch (e) {
      const err = e as ApiError
      if (err.status === 409) {
        setError(
          err.message?.toLowerCase().includes('platform')
            ? 'This account is a PLATFORM/INTERNAL account and cannot be converted to billing.'
            : 'This account is already on BILLING.',
        )
      } else if (err.status === 422) {
        setError('Missing required billing contact information.')
      } else {
        setError(err.message || 'Failed to convert account.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        Convert to Paid
        <IconButton size="small" onClick={handleClose} disabled={submitting}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Converting <strong>{accountName ?? 'this account'}</strong> from TRIAL to BILLING clears
          the trial end date and starts billing immediately. This cannot be undone from this dialog.
        </Typography>

        <Stack spacing={2}>
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
            value={addressLine1}
            onChange={(e) => setAddressLine1(e.target.value)}
          />
          <Stack direction="row" spacing={2}>
            <TextField
              label="City"
              size="small"
              required
              fullWidth
              value={addressCity}
              onChange={(e) => setAddressCity(e.target.value)}
            />
            <TextField
              label="Region / State"
              size="small"
              fullWidth
              value={addressRegion}
              onChange={(e) => setAddressRegion(e.target.value)}
            />
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField
              label="Postal code"
              size="small"
              fullWidth
              value={addressPostalCode}
              onChange={(e) => setAddressPostalCode(e.target.value)}
            />
            <TextField
              label="Country"
              size="small"
              required
              fullWidth
              value={addressCountry}
              onChange={(e) => setAddressCountry(e.target.value)}
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
            helperText="Not collected yet (FEATURE_STRIPE). Billing starts on invoice/PO until Stripe is wired in."
          />

          <TextField
            label="Reason"
            size="small"
            placeholder="Optional — why is this account converting now?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            multiline
            minRows={2}
          />

          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={submitting}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={submitting}
          startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {submitting ? 'Converting…' : 'Convert to BILLING'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
