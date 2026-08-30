import { Box, Typography } from '@mui/material'

import { INVITATION_KINDS, InvitationKind } from '../types/invitations'

// InvitationKindForm — SCK-605 landing pad.
//
// Scaffolding for the generic per-kind mint form. Future SCK layer stories
// fill in the per-kind field groups (email, project name, trial length,
// role, account, …). For now every kind renders the same placeholder — the
// intent is only to lock in the component contract so call-sites can start
// integrating.
export interface InvitationKindFormProps<T = unknown> {
  kind: InvitationKind
  value?: T
  onChange?: (next: T) => void
}

export default function InvitationKindForm<T = unknown>({
  kind,
  value,
  onChange,
}: InvitationKindFormProps<T>) {
  // Reference props so unused-var lints don't drop the contract before the
  // real implementation lands.
  void value
  void onChange

  const known = (INVITATION_KINDS as readonly string[]).includes(kind)

  return (
    <Box sx={{ p: 2, border: '1px dashed', borderColor: 'divider', borderRadius: 1 }}>
      <Typography variant="body2" color="text.secondary">
        Kind: {kind}
        {known ? '' : ' (unknown)'} — fields not yet implemented
        (SCK-605 landing pad).
      </Typography>
    </Box>
  )
}
