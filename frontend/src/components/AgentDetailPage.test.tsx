// UI tests for the per-agent detail page: status, history, start, check and
// heal all go through apiFetch to the admin backend's /api/agents/… proxy.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, apiFetch: vi.fn() }
})

import AgentDetailPage from './AgentDetailPage'
import { apiFetch } from '../api'

const mockApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

const AGENT = {
  name: 'ecr-healer',
  display_name: 'ECR Healer',
  type: 'EcrHealerAgent',
  is_running: false,
  health_score: 92,
  checks_performed: 10,
  issues_detected: 2,
  issues_healed: 2,
  last_check: null,
}

function route(url: string): Response {
  switch (url) {
    case '/api/agents/dashboard':
      return jsonResponse({ agents: [AGENT] })
    case '/api/agents/agents/ecr-healer/status':
      return jsonResponse({ name: 'ecr-healer', is_running: false })
    case '/api/agents/agents/ecr-healer/history?limit=50':
      return jsonResponse({ agent: 'ecr-healer', actions: [] })
    case '/api/agents/agents/ecr-healer/check':
      return jsonResponse({ detail: 'Not Found' }, 404)
    default:
      return jsonResponse({ status: 'started', success: true, actions: [] })
  }
}

beforeEach(() => {
  mockApiFetch.mockReset()
  mockApiFetch.mockImplementation(async (url: string) => route(url))
  sessionStorage.clear()
  // No token in sessionStorage, so the alerts panel shows its sign-in hint
  // and makes no coordinator call; fail loudly if anything else uses fetch.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      throw new Error(`unexpected fetch: ${String(url)}`)
    }),
  )
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AgentDetailPage', () => {
  it('reads dashboard, status and history through the admin backend', async () => {
    render(<AgentDetailPage agentName="ecr-healer" onBack={() => {}} />)
    await screen.findByText('Manual Actions')
    expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/dashboard')
    expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/agents/ecr-healer/status')
    expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/agents/ecr-healer/history?limit=50')
  })

  it('posts start, check and heal to /api/agents', async () => {
    const user = userEvent.setup()
    render(<AgentDetailPage agentName="ecr-healer" onBack={() => {}} />)
    await screen.findByText('Manual Actions')

    await user.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/agents/ecr-healer/start', {
        method: 'POST',
      }),
    )

    await user.click(screen.getByRole('button', { name: 'Trigger Check Now' }))
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/agents/ecr-healer/check', {
        method: 'POST',
      }),
    )
    // Upstream 404 → the button is disabled as "not available".
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Trigger Check Now' })).toBeDisabled(),
    )

    await user.click(screen.getByRole('button', { name: 'Dry-Run Heal' }))
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/agents/heal',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    const healCall = mockApiFetch.mock.calls.find((c) => c[0] === '/api/agents/heal')
    expect(JSON.parse(String(healCall?.[1]?.body))).toEqual({
      agent: 'ecr-healer',
      dry_run: true,
    })

    for (const call of mockApiFetch.mock.calls) {
      expect(String(call[0]).startsWith('/api/agents/')).toBe(true)
    }
  })

  it('shows the backend message when start fails', async () => {
    mockApiFetch.mockImplementation(async (url: string) =>
      url.endsWith('/start')
        ? jsonResponse(
            { error: 'AGENTS_UPSTREAM_ERROR', message: 'agents service returned HTTP 500' },
            502,
          )
        : route(url),
    )
    const user = userEvent.setup()
    render(<AgentDetailPage agentName="ecr-healer" onBack={() => {}} />)
    await screen.findByText('Manual Actions')
    await user.click(screen.getByRole('button', { name: 'Start' }))
    expect(await screen.findByText('agents service returned HTTP 500')).toBeInTheDocument()
  })
})
