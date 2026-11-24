// Unit tests for the agents-proxy helpers in api.ts.

import { describe, it, expect } from 'vitest'
import { AGENTS_API_BASE, agentsApiPath, responseErrorMessage } from './api'

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('no body')
      return body
    },
  } as unknown as Response
}

describe('agentsApiPath', () => {
  it('builds same-origin admin-backend paths', () => {
    expect(AGENTS_API_BASE).toBe('/api/agents')
    expect(agentsApiPath('dashboard')).toBe('/api/agents/dashboard')
    expect(agentsApiPath('agents', 'ecr-healer', 'status')).toBe(
      '/api/agents/agents/ecr-healer/status',
    )
  })

  it('encodes each segment so a value cannot add segments or change the host', () => {
    expect(agentsApiPath('agents', '../dashboard', 'start')).toBe(
      '/api/agents/agents/..%2Fdashboard/start',
    )
    expect(agentsApiPath('agents', 'a/b?c#d', 'stop')).toBe(
      '/api/agents/agents/a%2Fb%3Fc%23d/stop',
    )
    expect(agentsApiPath('agents', '//evil.test', 'status').startsWith('/api/agents/')).toBe(true)
  })
})

describe('responseErrorMessage', () => {
  it('prefers the admin backend message', async () => {
    const msg = await responseErrorMessage(
      fakeResponse(503, { error: 'AGENTS_PROXY_NOT_CONFIGURED', message: 'not configured' }),
      'Failed',
    )
    expect(msg).toBe('not configured')
  })

  it('falls back to an upstream detail string', async () => {
    const msg = await responseErrorMessage(
      fakeResponse(404, { detail: "Agent 'x' not found" }),
      'Failed',
    )
    expect(msg).toBe("Agent 'x' not found")
  })

  it('falls back to the status when the body is not JSON', async () => {
    expect(await responseErrorMessage(fakeResponse(502, undefined), 'Failed to start agent')).toBe(
      'Failed to start agent (HTTP 502)',
    )
  })
})
