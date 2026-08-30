// UI tests for the SYSTEM invitation wizards inside InvitationsTab —
// SCK-624 (PROJECT_MEMBER form) and SCK-628 (BETA form).
//
// Each ticket has two tests, mirroring the two load-bearing observables
// from the task spec:
//   * kind selector switch renders the kind-specific typeaheads / toggles
//   * clicking Create invitation POSTs to the right kind endpoint with
//     the payload shape the backend expects, and the result modal opens
//     showing the redemption URL.
//
// Note on the MUI Autocomplete stub below: the shipped code accesses
// `params.InputProps.endAdornment` inside `renderInput`, which is a MUI-5-era
// API that MUI 9 dropped (renderInput now receives `slotProps.input` only).
// That means the real Autocomplete throws on first render in a test env
// (see the "AC HAS InputProps: false" note). Rather than gate the whole
// test bootstrap on a production fix, we stub Autocomplete so the toggle
// path stays observable. The underlying renderInput incompat is filed as
// a follow-up.
//
// The stub also renders one hidden button per option so tests can click
// to "select" that option — a hand-rolled version of the popup+listbox
// interaction the real MUI Autocomplete provides.

import type { ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Mock the api module BEFORE importing the component. All coordinatorGet
// calls (invitation list poll + typeaheads) resolve to empty pages/lists
// by default; individual tests can override to seed typeahead options.
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
  interface AutocompleteStubProps<T> {
    options?: T[]
    onChange?: (event: unknown, next: T | null) => void
    getOptionLabel?: (opt: T) => string
    renderInput: (params: unknown) => ReactNode
  }
  // The stub renders a placeholder tagged with the TextField label so tests
  // can still assert "this typeahead is visible for this invite kind", plus
  // one hidden button per option so a test can click to "select" it —
  // standing in for the popup+listbox the real MUI Autocomplete provides.
  const AutocompleteStub = <T,>({
    options = [],
    onChange,
    getOptionLabel,
    renderInput,
  }: AutocompleteStubProps<T>) => {
    const node = renderInput({
      id: 'autocomplete-stub',
      disabled: false,
      fullWidth: true,
      size: 'small',
      InputProps: { endAdornment: null },
      inputProps: {},
      slotProps: { input: {}, inputLabel: {} },
    })
    return (
      <div data-testid="autocomplete-stub">
        {node as ReactNode}
        {options.map((opt, i) => {
          const label = getOptionLabel ? getOptionLabel(opt) : String(opt)
          return (
            <button
              key={i}
              type="button"
              data-testid={`autocomplete-option-${label}`}
              onClick={() => onChange?.({}, opt)}
            >
              select {label}
            </button>
          )
        })}
      </div>
    )
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

    // Default GET router — the list + typeahead endpoints all settle
    // without erroring. Individual tests override to seed options.
    coordinatorGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/invitations')) {
        return Promise.resolve(emptyInvitationsPage)
      }
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

    it('submits POST /api/v1/invitations/project-member with the picked account + project + role', async () => {
      // Seed the account + project typeaheads with one option each so the
      // stub renders selectable buttons.
      coordinatorGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/invitations')) return Promise.resolve(emptyInvitationsPage)
        if (path.startsWith('/api/v1/accounts')) {
          return Promise.resolve([{ id: 'acct-1', name: 'acme' }])
        }
        if (path.startsWith('/api/v1/k8s-project')) {
          return Promise.resolve([{ id: 'proj-1', name: 'web' }])
        }
        return Promise.resolve([])
      })
      coordinatorPostMock.mockResolvedValue({
        invitation: {
          id: 'inv-1',
          email: 'user@example.com',
          kind: 'PROJECT_MEMBER',
          target_account_name: 'acme',
          target_project_name: 'web',
        },
        code: 'abc',
        redemptionUrl: 'https://console.control.apps.clue2.app/redeem?token=abc',
      })

      const user = userEvent.setup()
      render(<InvitationsTab />)
      await waitFor(() =>
        expect(coordinatorGetMock).toHaveBeenCalledWith(
          expect.stringMatching(/^\/api\/v1\/invitations\?/),
        ),
      )

      await clickInviteTypeToggle(user, /^Project member$/i)
      // Wait for the account typeahead to fire.
      await waitFor(() =>
        expect(coordinatorGetMock).toHaveBeenCalledWith(
          expect.stringMatching(/^\/api\/v1\/accounts/),
        ),
      )

      await user.type(
        screen.getByLabelText(/Invitee email/i, { selector: 'input' }),
        'user@example.com',
      )
      // Select the seeded account — this triggers the project load.
      await user.click(await screen.findByTestId('autocomplete-option-acme'))
      // Wait for the project typeahead to arrive with our seeded option.
      await user.click(await screen.findByTestId('autocomplete-option-web'))

      await user.click(
        screen.getByRole('button', { name: /Create invitation/i }),
      )

      // Result dialog is the observable "submit succeeded" signal.
      expect(
        await screen.findByText(/Invitation created/i),
      ).toBeInTheDocument()

      expect(coordinatorPostMock).toHaveBeenCalledTimes(1)
      const [path, body] = coordinatorPostMock.mock.calls[0]
      expect(path).toBe('/api/v1/invitations/project-member')
      expect(body).toMatchObject({
        email: 'user@example.com',
        targetAccountId: 'acct-1',
        targetProjectId: 'proj-1',
        role: 'CONTRIBUTOR',
        deliveryMode: 'email',
      })
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

    it('submits POST /api/v1/invitations/beta with the picked flag + bootstrap account name', async () => {
      // Seed the feature-flag typeahead with one option.
      coordinatorGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/invitations')) return Promise.resolve(emptyInvitationsPage)
        if (path.startsWith('/api/v1/feature-flags')) {
          return Promise.resolve([
            { id: 'flag-1', name: 'new-onboarding', description: null },
          ])
        }
        return Promise.resolve([])
      })
      coordinatorPostMock.mockResolvedValue({
        invitation: {
          id: 'inv-2',
          email: 'beta@example.com',
          kind: 'BETA',
          target_feature_flag_id: 'flag-1',
          target_feature_flag_name: 'new-onboarding',
          bootstrap_account: true,
          accountName: 'beta-acct',
        },
        code: 'xyz',
        redemptionUrl: 'https://console.control.apps.clue2.app/redeem?token=xyz',
      })

      const user = userEvent.setup()
      render(<InvitationsTab />)
      await waitFor(() =>
        expect(coordinatorGetMock).toHaveBeenCalledWith(
          expect.stringMatching(/^\/api\/v1\/invitations\?/),
        ),
      )

      await clickInviteTypeToggle(user, /^Beta$/i)
      await waitFor(() =>
        expect(coordinatorGetMock).toHaveBeenCalledWith(
          expect.stringContaining('/api/v1/feature-flags?availableAsBetaInvite=true'),
        ),
      )

      await user.type(
        screen.getByLabelText(/Invitee email/i, { selector: 'input' }),
        'beta@example.com',
      )
      // Select the seeded flag.
      await user.click(
        await screen.findByTestId('autocomplete-option-new-onboarding'),
      )
      // Tick bootstrap + name the account.
      await user.click(
        screen.getByRole('checkbox', { name: /Bootstrap a new account/i }),
      )
      await user.type(
        await screen.findByLabelText(/Account name/i, { selector: 'input' }),
        'beta-acct',
      )

      await user.click(
        screen.getByRole('button', { name: /Create invitation/i }),
      )

      // Result dialog is the observable "submit succeeded" signal.
      expect(
        await screen.findByText(/Invitation created/i),
      ).toBeInTheDocument()

      expect(coordinatorPostMock).toHaveBeenCalledTimes(1)
      const [path, body] = coordinatorPostMock.mock.calls[0]
      expect(path).toBe('/api/v1/invitations/beta')
      expect(body).toMatchObject({
        email: 'beta@example.com',
        targetFeatureFlagId: 'flag-1',
        bootstrapAccount: true,
        accountName: 'beta-acct',
        deliveryMode: 'email',
      })
    })
  })
})
