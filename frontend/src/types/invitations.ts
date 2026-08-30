// Shared invitation kind enum (SCK-605).
//
// This is the frontend source of truth for the set of invitation kinds the
// coordinator can mint. Future per-kind field renderers (SCK layer stories)
// consume INVITATION_KINDS to drive their kind selector + field visibility.
//
// Keep in sync with:
//   - console/src/types/invitations.js (sibling PR)
//   - coord's InvitationKind (server-side enum)
export type InvitationKind =
  | 'SOLO'
  | 'ACCOUNT_ADMIN'
  | 'ACCOUNT_MEMBER'
  | 'PROJECT_MEMBER'
  | 'BETA'

export const INVITATION_KINDS: InvitationKind[] = [
  'SOLO',
  'ACCOUNT_ADMIN',
  'ACCOUNT_MEMBER',
  'PROJECT_MEMBER',
  'BETA',
]

// Legacy DB alias — read-only during the SCK-620 rename transition
// (per decision #6). New invites should not be minted with these kinds;
// they are only surfaced when the coordinator returns them on historical
// records.
export const LEGACY_INVITATION_KINDS = ['BILLING_ACCOUNT'] as const
export type LegacyInvitationKind = (typeof LEGACY_INVITATION_KINDS)[number]
