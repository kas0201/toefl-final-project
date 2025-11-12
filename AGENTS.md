# Repository Guidelines

## Project Structure & Module Organization
The backend lives in `server.js`, a single Express app that wires PostgreSQL via `pg`, handles auth middleware, queues Cloudflare TTS jobs, and serves every API route under `/api`. Static client flows (dashboard, practice center, exam runner, etc.) sit in `public/*.html` with shared auth helpers in `public/auth.js`; keep new front-end assets next to their page and load extra scripts with `<script type="module">`. VS Code tasks in `.vscode/` and the new `/health` endpoint mirror production readiness probes, so lean on them when debugging locally.

## Build, Test, and Development Commands
```bash
npm install          # install Node 18 dependencies
npm start            # runs server.js on PORT (defaults to 3000)
npm test             # executes node --test suites in tests/*.test.js
```
Use `.env.example` as your checklist for environment variables, then export them in your shell (or copy into an untracked `.env`). `npm start` exits early if `DATABASE_URL` is missing or invalid.

## Coding Style & Naming Conventions
Stick to 2-space indentation and single quotes unless template literals are required; prefer `const`/`let` over `var` and `async/await` over promise chains to match the existing code. Use `camelCase` for functions and variables, `PascalCase` only for classes, and `SCREAMING_SNAKE_CASE` for env keys. HTML/CSS assets follow kebab-case filenames (for example `practice-center.html`), and any new IDs or class names should mirror that pattern.

## Testing Guidelines
Automated tests live under `tests/` and run through the built-in Node test runner (`node --test`). Seed `NODE_ENV=test` plus a disposable `DATABASE_URL` before importing the app; most suites can stub `pool.query` the way `tests/health.test.js` does to avoid touching real infrastructure. For manual verification, register through `POST /api/auth/register`, log in via `POST /api/auth/login`, hit `/api/questions` with the issued JWT, and walk `public/login.html -> dashboard.html`.

## Commit & Pull Request Guidelines
Recent history mixes bare messages (`test`) and prefixed ones (`Feat: ...`); move toward Conventional Commits (`feat:`, `fix:`, `chore:`) with focused scopes and linked issue IDs when available. Each pull request should explain the goal, list the routes/pages touched, attach screenshots or HAR snippets for UI changes, describe database impacts, and document the tests you ran (`npm test`, smoke hit on key APIs, manual UI tour). Never commit sample `.env` files or secrets; rotate tokens immediately if something slips.

## Environment & Security Notes
`server.js` pulls secrets from `DATABASE_URL`, `JWT_SECRET`, the three Cloudinary keys, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `DEEPSEEK_API_KEY`. Use `.env.example` as the canonical template, keep the real `.env` untracked, and prefer scoped API tokens with the minimum permissions. During local development, point uploads to a non-production Cloudinary folder such as `toefl_lectures-dev`, disable background audio jobs you do not need, and never expose Render or database credentials in logs.
