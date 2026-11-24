// UI tests for the Platform Agents list: every agents-service call goes
// through apiFetch to the admin backend's same-origin /api/agents/… proxy.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, apiFetch: vi.fn() }
})

import AgentsTab from './AgentsTab'
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

function calledUrls(): string[] {
  return mockApiFetch.mock.calls.map((c) => String(c[0]))
}

beforeEach(() => {
  mockApiFetch.mockReset()
  mockApiFetch.mockImplementation(async (url: string) =>
    url === '/api/agents/dashboard'
      ? jsonResponse({ summary: { total_agents: 1, running_agents: 0 }, agents: [AGENT] })
      : jsonResponse({ status: 'ok', success: true, actions: [] }),
  )
  // The alerts panel reads the coordinator with plain fetch.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({ content: [], totalElements: 0 })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AgentsTab', () => {
  it('loads the dashboard through the admin backend', async () => {
    render(<AgentsTab />)
    await screen.findByText('ECR Healer')
    expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/dashboard')
  })

  it('starts an agent and triggers heal through /api/agents', async () => {
    const user = userEvent.setup()
    render(<AgentsTab />)
    await screen.findByText('ECR Healer')

    await user.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/agents/ecr-healer/start', {
        method: 'POST',
      }),
    )

    await user.click(screen.getByRole('button', { name: 'Dry Run' }))
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
  })

  it('never calls an absolute agents URL', async () => {
    const user = userEvent.setup()
    render(<AgentsTab />)
    await screen.findByText('ECR Healer')
    await user.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(mockApiFetch.mock.calls.length).toBeGreaterThan(1))
    for (const url of calledUrls()) {
      expect(url.startsWith('/api/agents/')).toBe(true)
    }
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain('clue2app-agents')
    }
  })

  it('shows the backend message when an action fails', async () => {
    mockApiFetch.mockImplementation(async (url: string) =>
      url === '/api/agents/dashboard'
        ? jsonResponse({ agents: [AGENT] })
        : jsonResponse(
            {
              error: 'AGENTS_PROXY_NOT_CONFIGURED',
              message: 'the agents proxy is not configured on this admin instance',
            },
            503,
          ),
    )
    const user = userEvent.setup()
    render(<AgentsTab />)
    await screen.findByText('ECR Healer')
    await user.click(screen.getByRole('button', { name: 'Start' }))
    expect(
      await screen.findByText('the agents proxy is not configured on this admin instance'),
    ).toBeInTheDocument()
  })
})
