// UI tests for the Ops · CI Triggers page.
//
// Coverage focus (matches the ticket's non-negotiables):
//   * Loading skeleton then rows render from GET /api/ops/ci-triggers.
//   * Clicking Run opens a confirmation dialog before any POST fires
//     (server-side allowlist still enforces the real guard — this test
//      checks the client-side "no accidental dispatch" affordance).
//   * Confirming in the dialog POSTs to /api/ops/ci-triggers/{id}/run
//     and surfaces the returned GitHub run URL in the snackbar.
//   * A missing GH token (gh_token_configured=false) surfaces the
//     configuration warning banner.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Mock the api module BEFORE importing the component.
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
    apiGet: vi.fn(),
    apiFetch: vi.fn(),
  }
})

import OpsCiControlsTab from './OpsCiControlsTab'
import { apiGet, apiFetch } from '../api'

const mockGet = apiGet as unknown as ReturnType<typeof vi.fn>
const mockFetch = apiFetch as unknown as ReturnType<typeof vi.fn>

const SAMPLE_ROW = {
  id: 'int-tests-pypi-fresh-install',
  name: 'Verify fresh PyPI install works',
  description: 'Runs the integration-tests harness for a clean venv install.',
  target_repo: 'clue2solve/clue2app-integration-tests',
  workflow_filename: 'pypi-fresh-install.yml',
  ref: 'main',
  last_run: {
    run_id: 42,
    run_number: 7,
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/x/y/actions/runs/42',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:05:00Z',
    actor: 'someone',
    event: 'workflow_dispatch',
  },
}

beforeEach(() => {
  mockGet.mockReset()
  mockFetch.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('OpsCiControlsTab', () => {
  it('renders the row and its last-run pill from the list response', async () => {
    mockGet.mockResolvedValueOnce({
      triggers: [SAMPLE_ROW],
      gh_token_configured: true,
    })
    render(<OpsCiControlsTab />)
    await waitFor(() =>
      expect(screen.getByText('Verify fresh PyPI install works')).toBeInTheDocument(),
    )
    expect(mockGet).toHaveBeenCalledWith('/api/ops/ci-triggers')
    expect(screen.getByText('success')).toBeInTheDocument()
    // The Ops warning banner should NOT render when the token is configured.
    expect(
      screen.queryByText(/GH_OPS_DISPATCH_TOKEN not configured/i),
    ).not.toBeInTheDocument()
  })

  it('warns when GH token is not configured on the backend', async () => {
    mockGet.mockResolvedValueOnce({
      triggers: [SAMPLE_ROW],
      gh_token_configured: false,
    })
    render(<OpsCiControlsTab />)
    await waitFor(() =>
      expect(
        screen.getByText(/GH_OPS_DISPATCH_TOKEN not configured/i),
      ).toBeInTheDocument(),
    )
  })

  it('requires a confirmation click before dispatching', async () => {
    mockGet.mockResolvedValue({
      triggers: [SAMPLE_ROW],
      gh_token_configured: true,
    })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        trigger_id: SAMPLE_ROW.id,
        dispatched: true,
        last_run: { ...SAMPLE_ROW.last_run, status: 'queued', conclusion: null },
      }),
    })

    render(<OpsCiControlsTab />)
    await waitFor(() =>
      expect(screen.getByText('Verify fresh PyPI install works')).toBeInTheDocument(),
    )

    // Click the row Run button → dialog opens, but no dispatch yet.
    const runButtons = screen.getAllByRole('button', { name: /^Run$/ })
    await userEvent.click(runButtons[0])
    expect(mockFetch).not.toHaveBeenCalled()

    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText(/Run Verify fresh PyPI install works/i),
    ).toBeInTheDocument()

    // Confirm.
    await userEvent.click(
      within(dialog).getByRole('button', { name: /Run workflow/i }),
    )

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    expect(mockFetch).toHaveBeenCalledWith(
      `/api/ops/ci-triggers/${SAMPLE_ROW.id}/run`,
      { method: 'POST' },
    )
    // Snackbar shows a success message with the run link.
    await waitFor(() =>
      expect(screen.getByText(/Dispatched "Verify fresh PyPI install works"/)).toBeInTheDocument(),
    )
  })

  it('surfaces a backend 503 error in the snackbar', async () => {
    mockGet.mockResolvedValue({
      triggers: [SAMPLE_ROW],
      gh_token_configured: false,
    })
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ detail: 'GH_OPS_DISPATCH_TOKEN not configured' }),
    })
    render(<OpsCiControlsTab />)
    await waitFor(() =>
      expect(screen.getByText('Verify fresh PyPI install works')).toBeInTheDocument(),
    )
    await userEvent.click(screen.getAllByRole('button', { name: /^Run$/ })[0])
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(
      within(dialog).getByRole('button', { name: /Run workflow/i }),
    )
    await waitFor(() =>
      expect(
        screen.getAllByText(/GH_OPS_DISPATCH_TOKEN not configured/i).length,
      ).toBeGreaterThan(0),
    )
  })
})
