// UI tests for SCK-568 slice B — SYSTEM-side support-access approval.
//
// Task spec: visit Orgs → Requests → row expand → Approve → mock 200 with
// sessionToken → toast + session-token modal.
//
// As of the branch this test file lands on, the admin-app UI for the
// approval flow has NOT been shipped yet — a repo-wide grep for
// "support-access", "SupportAccess", "sessionToken", "SCK-568", and the
// "Requests" label under OrgsTab returns no matches on the frontend. The
// backend endpoint is in flight on a sibling branch; the admin-side render
// hooks up after that lands.
//
// Rather than pretend the flow exists (an always-passing skip masks the
// coverage gap) or leave the file empty (loses the spec for the operator
// building the UI), we materialise the acceptance criteria as an xdescribe
// block. Once the UI lands, the operator implementing it removes the `x`
// and fills in the two placeholder tests below — they are shaped to the
// expected API surface (POST /api/v1/support-access/{id}/approve → 200 +
// { sessionToken }) and the observable UX (toast + session-token modal
// with a copy affordance).
//
// Tracking: filed under SCK-568 slice B — "UI: approval affordance"
// (blocked-on: SCK-568 slice A — backend endpoint).

import { describe, it } from 'vitest'

// xdescribe: intentionally skipped until the admin-side support-access
// approval UI exists. Removing the `x` here will surface both tests to
// the runner; they will fail until the component is wired.
describe.skip('SCK-568 slice B — support-access approval (blocked on UI)', () => {
  it('expanding a request row exposes an Approve button that POSTs to /api/v1/support-access/{id}/approve', () => {
    // 1. Render <OrgsTab /> (or wherever the Requests panel lives).
    // 2. Wait for the Requests panel to load its rows.
    // 3. Click the row's expand affordance.
    // 4. Assert the Approve button becomes visible.
    // 5. Click Approve.
    // 6. Assert coordinatorPost was called with:
    //      path: /api/v1/support-access/{id}/approve
    //      body: {} (or the shape the backend settles on)
    throw new Error(
      'placeholder — implement once the support-access approval UI ships',
    )
  })

  it('a 200 response with { sessionToken } renders the toast + session-token modal', () => {
    // 1. Mock coordinatorPost to resolve with { sessionToken: "sess_abc" }.
    // 2. Drive the Approve click as above.
    // 3. Assert the toast/snackbar copy: "Support session opened".
    // 4. Assert the session-token modal opens showing "sess_abc" in a
    //    readonly input with a copy affordance (mirror the pattern used
    //    by NewAccountWizard's redemption-URL modal — same MUI-9
    //    IconButton caveat applies).
    throw new Error(
      'placeholder — implement once the support-access approval UI ships',
    )
  })
})
