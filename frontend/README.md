# clue2app-admin — frontend

React + MUI + TypeScript, built with Vite. The Knative service still ships
under its legacy name `aws-dashboard`; see `../README-deploy.md` for the
platform deployment story.

## Local dev

```
cd frontend
npm install
npm run dev
```

`vite.config.ts` proxies `/api` → `http://localhost:54321`, so run the
FastAPI backend alongside:

```
cd backend
pip install -r requirements.txt
python main.py
```

## Tests

Vitest + React Testing Library + jsdom. Bootstrapped for the admin
surface in the same PR that retro-fits SCK-621 / SCK-624 / SCK-628
coverage.

```
cd frontend
npm ci              # first time, or after a devDeps bump
npm test            # one-shot run (also what CI runs)
npm run test:watch  # local watch mode
npm run test:coverage
```

- Test files live next to the code they cover, named `*.test.tsx` or
  `*.test.ts` under `src/`.
- Global setup is in `src/test-setup.ts` (jest-dom matchers, `matchMedia`
  + `ResizeObserver` stubs for MUI).
- Config: `vitest.config.ts` — kept separate from `vite.config.ts` so the
  dev/build path stays untouched.
- CI: `.github/workflows/frontend-tests.yml` — path-filtered to
  `frontend/**`, runs on every PR and push to `main`.

Adding a test:

1. Drop `Foo.test.tsx` next to `Foo.tsx`.
2. Mock `../api` if the component fetches anything (see the existing
   `InvitationsTab.test.tsx` / `NewAccountWizard.test.tsx` for the
   pattern).
3. Prefer role-based queries (`getByRole`, `getByLabelText`) over test
   IDs.

## Build

```
cd frontend
npm run build
```

`build.sh` at the repo root wraps the frontend build + copies static
assets into `backend/static/` for the Paketo image.
