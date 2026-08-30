// Retro-fit test for SCK-621 (NewAccountWizard).
//
// Scope kept intentionally small — this is bootstrap coverage that lands
// alongside the vitest infra PR. Verifies:
//   1. Step navigation: rendering starts on "Account details", filling the
//      required field + clicking Next moves the stepper to the invite step.
//   2. Submit path: clicking "Create account" from step 2 posts to the
//      SCK-620 endpoint with the merged payload shape.
//
// Deeper per-field validation + error-path coverage is a follow-up.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Mock the api module BEFORE importing the component under test so the
// component picks up the mocked coordinatorPost.
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
    coordinatorPost: vi.fn(),
  }
})

import NewAccountWizard from './NewAccountWizard'
import * as api from '../api'

const coordinatorPostMock = api.coordinatorPost as unknown as ReturnType<typeof vi.fn>

const invitationResult = {
  invitation: {
    id: 'inv-1',
    email: 'admin@example.com',
    accountName: 'acme',
    redemptionUrl: 'https://console.control.apps.clue2.app/redeem?token=abc',
    expires_on: '2026-09-30T00:00:00Z',
    deliveryMode: 'email' as const,
    sesEnabled: true,
    billingInfoCaptured: false,
  },
}

describe('NewAccountWizard (SCK-621)', () => {
  beforeEach(() => {
    coordinatorPostMock.mockReset()
    coordinatorPostMock.mockResolvedValue(invitationResult)
  })

  it('starts on step 1 and advances to step 2 when Next is clicked with valid input', async () => {
    const user = userEvent.setup()
    render(
      <NewAccountWizard open onClose={() => {}} onCreated={() => {}} />,
    )

    // Step 1 marker copy.
    expect(
      screen.getByText(/Provision a new account/i),
    ).toBeInTheDocument()

    // Fill required account-name field (defaults for max projects + trial
    // days already satisfy validation).
    const nameInput = screen.getByLabelText(/Account name/i, { selector: 'input' })
    await user.type(nameInput, 'acme')

    await user.click(screen.getByRole('button', { name: /^Next$/i }))

    // Step 2 renders the Admin email field (absent from step 1) — this is
    // the observable stepper-advanced signal.
    expect(
      await screen.findByLabelText(/Admin email/i, { selector: 'input' }),
    ).toBeInTheDocument()
    // And the primary CTA switches from "Next" to "Create account".
    expect(
      screen.getByRole('button', { name: /Create account/i }),
    ).toBeInTheDocument()
  })

  it('submits POST /api/v1/invitations/account-admin with the merged step-1 + step-2 payload', async () => {
    const user = userEvent.setup()
    render(
      <NewAccountWizard open onClose={() => {}} onCreated={() => {}} />,
    )

    await user.type(
      screen.getByLabelText(/Account name/i, { selector: 'input' }),
      'acme',
    )
    await user.click(screen.getByRole('button', { name: /^Next$/i }))

    await user.type(
      screen.getByLabelText(/Admin email/i, { selector: 'input' }),
      'admin@example.com',
    )
    await user.click(screen.getByRole('button', { name: /Create account/i }))

    // The result dialog is the observable "submit succeeded" signal.
    expect(await screen.findByText(/Account created/i)).toBeInTheDocument()

    expect(coordinatorPostMock).toHaveBeenCalledTimes(1)
    const [path, body] = coordinatorPostMock.mock.calls[0]
    expect(path).toBe('/api/v1/invitations/account-admin')
    expect(body).toMatchObject({
      email: 'admin@example.com',
      accountName: 'acme',
      trialLengthDays: 14,
      maxProjects: 5,
      deliveryMode: 'email',
    })
  })
})
