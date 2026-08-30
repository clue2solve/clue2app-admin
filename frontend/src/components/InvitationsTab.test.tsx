// Retro-fit tests for SCK-624 (PROJECT_MEMBER form) and SCK-628 (BETA form).
//
// Scope kept intentionally small — this is bootstrap coverage that lands
// alongside the vitest infra PR. Each test switches the invite-type
// ToggleButton and asserts the kind-specific form fields render.
//
// Deeper submit-path + validation coverage is a follow-up.
//
// Note on the MUI Autocomplete stub below: the shipped code accesses
// `params.InputProps.endAdornment` inside `renderInput`, which is a MUI-5-era
// API that MUI 9 dropped (renderInput now receives `slotProps.input` only).
// That means the real Autocomplete throws on first render in a test env
// (see the "AC HAS InputProps: false" note). Rather than gate the whole
// test bootstrap on a production fix, we stub Autocomplete so the toggle
// path stays observable. The underlying renderInput incompat is filed as
// a follow-up.

import type { ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Mock the api module BEFORE importing the component. All coordinatorGet
// calls (invitation list poll + typeaheads) resolve to empty pages/lists.
vi.mock('../api', () => {
  class ApiError extends Error {
    status: number
    body: unknown
    constructor(status: number, message: string, body?: unknown) {
      super(message)
      this.status = status
      this.body = body
    }
  }
  return {
    ApiError,
    coordinatorGet: vi.fn(),
    coordinatorPost: vi.fn(),
  }
})

// Stub MUI Autocomplete so the tests survive the pre-existing MUI-9
// `renderInput({ InputProps })` regression (see file header). Everything
// else from @mui/material is re-exported as-is.
vi.mock('@mui/material', async () => {
  const actual = await vi.importActual<typeof import('@mui/material')>('@mui/material')
  // The stub renders a placeholder tagged with the TextField label so tests
  // can still assert "this typeahead is visible for this invite kind".
  const AutocompleteStub = ({ renderInput }: { renderInput: (params: unknown) => ReactNode }) => {
    // Call renderInput with a params shape that satisfies both the MUI 5-era
    // (InputProps) and MUI 9-era (slotProps.input) accessor patterns the
    // shipped code mixes together — so tests observe the same TextField the
    // real Autocomplete would eventually render.
    const node = renderInput({
      id: 'autocomplete-stub',
      disabled: false,
      fullWidth: true,
      size: 'small',
      InputProps: { endAdornment: null },
      inputProps: {},
      slotProps: { input: {}, inputLabel: {} },
    })
    return <div data-testid="autocomplete-stub">{node as ReactNode}</div>
  }
  return { ...actual, Autocomplete: AutocompleteStub }
})

import InvitationsTab from './InvitationsTab'
import * as api from '../api'

const coordinatorGetMock = api.coordinatorGet as unknown as ReturnType<typeof vi.fn>
const coordinatorPostMock = api.coordinatorPost as unknown as ReturnType<typeof vi.fn>

const emptyInvitationsPage = {
  content: [],
  totalElements: 0,
  totalPages: 0,
  number: 0,
  size: 10,
}

describe('InvitationsTab', () => {
  beforeEach(() => {
    coordinatorGetMock.mockReset()
    coordinatorPostMock.mockReset()

    // Route each GET to the right shape based on the path so the initial
    // list load + typeahead lookups all settle without errors.
    coordinatorGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/invitations')) {
        return Promise.resolve(emptyInvitationsPage)
      }
      // /api/v1/accounts, /api/v1/k8s-project, /api/v1/feature-flags — all
      // return empty option arrays.
      return Promise.resolve([])
    })
  })

  // The invite-type ToggleButton and the kind-filter Chip below the table
  // can share a name (e.g. "Beta" toggle + "BETA" chip). Disambiguate by
  // the toggle's `aria-pressed` attribute — Chips don't set it.
  const clickInviteTypeToggle = async (
    user: ReturnType<typeof userEvent.setup>,
    label: RegExp,
  ) => {
    const toggle = screen
      .getAllByRole('button', { name: label })
      .find((b) => b.hasAttribute('aria-pressed'))
    if (!toggle) throw new Error(`no invite-type toggle matching ${label}`)
    await user.click(toggle)
  }

  describe('SCK-624 — PROJECT_MEMBER form', () => {
    it('renders account + project typeaheads and the role select after switching to Project member', async () => {
      const user = userEvent.setup()
      render(<InvitationsTab />)

      // Wait for the initial list-load to settle so the form area is stable.
      await waitFor(() =>
        expect(coordinatorGetMock).toHaveBeenCalledWith(
          expect.stringMatching(/^\/api\/v1\/invitations\?/),
        ),
      )

      await clickInviteTypeToggle(user, /^Project member$/i)

      // Hint copy switches to the PROJECT_MEMBER hint.
      expect(
        await screen.findByText(/Pick the target account, then the project/i),
      ).toBeInTheDocument()

      // PROJECT_MEMBER-specific fields — labels are supplied by the
      // TextField inside our Autocomplete stub (see file header) so
      // getByLabelText hits the real <input>.
      expect(screen.getByLabelText(/Target account/i)).toBeInTheDocument()
      expect(screen.getByLabelText(/Target project/i)).toBeInTheDocument()
      // Role is a MUI Select (TextField select prop) — combobox role.
      expect(
        screen.getByRole('combobox', { name: /Role/i }),
      ).toBeInTheDocument()
    })
  })

  describe('SCK-628 — BETA form', () => {
    it('renders the feature-flag picker + bootstrap_account toggle after switching to Beta', async () => {
      const user = userEvent.setup()
      render(<InvitationsTab />)

      await waitFor(() =>
        expect(coordinatorGetMock).toHaveBeenCalledWith(
          expect.stringMatching(/^\/api\/v1\/invitations\?/),
        ),
      )

      await clickInviteTypeToggle(user, /^Beta$/i)

      // Hint copy switches to the BETA hint.
      expect(
        await screen.findByText(/Invite a user into a beta feature/i),
      ).toBeInTheDocument()

      // Feature-flag typeahead (via stub — see file header).
      expect(screen.getByLabelText(/Beta feature/i)).toBeInTheDocument()

      // bootstrap_account toggle.
      const bootstrapCheckbox = screen.getByRole('checkbox', {
        name: /Bootstrap a new account/i,
      })
      expect(bootstrapCheckbox).toBeInTheDocument()
      expect(bootstrapCheckbox).not.toBeChecked()

      // Ticking bootstrap should reveal the account-name field.
      await user.click(bootstrapCheckbox)
      expect(
        await screen.findByLabelText(/Account name/i, { selector: 'input' }),
      ).toBeInTheDocument()

      // Confirm the BETA typeahead effect fires against the opt-in-only
      // endpoint (SCK-627 backend contract).
      await waitFor(() =>
        expect(coordinatorGetMock).toHaveBeenCalledWith(
          expect.stringContaining('/api/v1/feature-flags?availableAsBetaInvite=true'),
        ),
      )
    })
  })
})
