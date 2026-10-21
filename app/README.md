# Release Management — application

Technical reference for the application. For the overview, the screens and the path of the personal access token, see the [root README](../README.md). The design lives in `../design/releaseManagement.pen`.

Pull requests come from Azure DevOps or GitHub, and tasks from Azure DevOps or Jira. You sign in with a Microsoft account (Azure DevOps only) or with a personal access token for each platform.

## Running

```bash
npm install
npm run dev
```

Open http://localhost:5173. Without a `.env` file, you sign in with a personal access token, entered on the screen itself.

| Command | What it does |
|---|---|
| `npm run dev` | API (port 3001) and front end (port 5173) with reload |
| `npm test` | Server tests |
| `npm run typecheck` | Types for the server and the front end |
| `npm run build` and `npm start` | Builds the front end and serves everything from the API on port 3001 |
| `npm run chaos -w server` | Chaos test against a local server |

To check the adapter against a real organization without writing anything, with `AZDO_ORG` and `AZDO_PAT` in `.env`: `cd server && npx tsx --env-file=../.env scripts/smoke-readonly.ts`.

To see the interface with fictitious data and no platform at all, start it with `AUTH_MODE=demo`.

## Running with Docker

The image builds the front end and serves everything from the API on port 3001, as `npm run build` and `npm start` do.

```bash
cp .env.example .env
docker compose up -d --build
```

Open http://localhost:3001. Before starting, set in `.env`:

- `APP_URL=http://localhost:3001`, the URL the browser uses.
- `SESSION_SECRET`, so sessions survive a restart. They are kept encrypted in the `data` volume. It is required: without it, `docker compose up` stops with `defina SESSION_SECRET`.
- `SESSION_MAX_AGE_DAYS`, optional (default 30): how many days a session lasts without use.
- `AZDO_ORG`, optional, to fill in the organization on the sign-in screen.

After changing `.env`, run `docker compose up -d` again. `docker compose down -v` also deletes the volume and, with it, every session.

## Connecting to Azure DevOps with a Microsoft account

1. In Microsoft Entra ID, create an **App registration** (single tenant, the same tenant linked to the Azure DevOps organization).
2. Under **Authentication**, add the **Web** platform with the redirect URI `http://localhost:5173/auth/microsoft/callback` (in production, `https://<your-domain>/auth/microsoft/callback`).
3. Under **Certificates & secrets**, create a client secret.
4. Under **API permissions**, add the delegated permission **Azure DevOps → user_impersonation** and grant admin consent if the tenant requires it.
5. Copy `.env.example` to `.env` and fill in `ENTRA_*`, `AZDO_ORG`, `AZDO_PROJECTS` and `SESSION_SECRET`.

Users only see and change what their Azure DevOps permissions allow. Creating the release branch requires permission to create branches in the repository; linking a task requires permission to edit work items.

In production, set `APP_URL` to the public URL (HTTPS) and, behind a proxy, `API_HOST=0.0.0.0`.

## Two ways to sign in

The sign-in screen has a selector between **Microsoft account** and **Personal access token**, and the last choice is remembered in the browser.

- **Personal access token:** always available. Each platform has its own token, and the scope guide is on the screen itself. Connecting another token to a platform replaces that platform's token, which is how you switch organizations.
  - **Azure DevOps:** organization and personal access token. Provides the PRs and the work items.
  - **GitHub:** organization (or user) and fine-grained token. Provides the PRs.
  - **Jira:** site (`company.atlassian.net`), account email and API token. Provides the tasks for GitHub PRs.
- **Microsoft account:** available when the app registration is configured (section above).

Connections add up within the same session. Opening the board requires Azure DevOps or GitHub; with both connected, the account menu chooses which one the PRs come from. With GitHub active and no Jira, the board and the releases work, but there are no tasks to link.

### Token handling

The personal access token is never in plain text outside the process memory at the moment it is used. The [root README](../README.md#how-the-personal-access-token-travels) describes the whole path; in short:

- **In transit:** the browser encrypts the token with a throwaway AES-GCM key and wraps that key with RSA-OAEP, using the public key the server generates at every start. Each submission carries a single-use nonce, so a captured submission can't be replayed.
- **On the server:** it is validated on the platform and stored sealed with AES-256-GCM, both in the in-memory session and in the `.data/sessions.enc` file.
- **In the browser:** only the session cookie (HttpOnly) exists, and it doesn't contain the token.

Without `SESSION_SECRET`, sessions aren't written to disk and are lost on every restart. The server warns about it at startup, and `GET /auth/mode` reports `sessionsPersisted: false`. Changing the secret makes the saved `sessions.enc` unreadable: the server logs that and everyone signs in again.

Sessions expire after `SESSION_MAX_AGE_DAYS` days (default 30) **without use**: each use renews the session and the cookie, so whoever uses the app regularly stays signed in. The renewal is written to disk at most once an hour per session. A token rejected by one platform only marks that connection as needing to reconnect; the session ends only when no valid connection is left.

Use HTTPS in production regardless: the transit encryption is an extra layer (the token doesn't appear in proxy logs or in the request body), but it doesn't protect the session cookie and doesn't hold against someone who can alter the traffic.

The server also:

- sends security headers on every response (Content-Security-Policy, `X-Frame-Options`, `nosniff`, `Referrer-Policy` and, over HTTPS, HSTS);
- limits sign-in attempts to 60 per minute per IP. Behind a reverse proxy, set `TRUST_PROXY=true`, otherwise every user counts as the proxy's IP;
- rejects project and repository ids that don't look like ids, and encodes all of them before building the platform URL.

## Languages

The interface speaks Portuguese, English and French and follows the browser language (the first one in the preference list that it knows; if none, English). There is no selector. The texts live in `web/src/locales`, with `pt.ts` as the source: the other catalogs must have the same keys, and TypeScript complains if one is missing. API error messages come in the same language, through the `Accept-Language` header the front end sends (`server/src/i18n.ts`).

The terms follow each platform's own interface: in French, "jeton d'accès personnel" and "élément de travail" as in Azure DevOps, and "ticket" as in Jira; in English, "work item" for Jira as well. GitHub's interface is English-only, so the French token guide quotes the buttons in English.

## How a release is put together

- **Merged**: PRs completed into `develop` whose "Merged PR N" doesn't yet appear in the base branch (`main` or `master`, whichever exists in the repository) or in the three latest release branches.
- **Which branches are releases**: `RELEASE_PATTERN` is a regular expression. The default accepts `release-sprint-35`, `release/2.15` and `release/0.1.0`, and requires the name to end with the number, which leaves out work branches (`release/131046-description`) and hotfixes (`release-sprint-35-hotfix`). The newest release is the one with the highest number, and the next suggested name follows its format; in a repository with no release, `RELEASE_FIRST` applies.
- **Creating the release branch**: each selected PR is cherry-picked, in merge order, onto a temporary branch starting from `main`. Only when all of them apply is `release/x.y` created; on a conflict, the temporary branches are deleted and nothing is left behind.
- **Release**: the PRs are read from the commit messages the branch has beyond `main` (or beyond the previous release, if that one has already been merged back into `main`).

### On GitHub and Jira

- **Project**: the organization (or user) given when connecting is the only project; its repositories are the repositories.
- **Which PR is in which branch**: by the number in the first line of the commit, `Merge pull request #N` or the squash's `(#N)`. A rebase merge leaves no number, so the PR isn't recognized.
- **Creating the release branch**: the GitHub API has no cherry-pick. Each PR is applied with a three-way merge on a temporary `rm-tmp/…` branch (the merge base is the parent of the PR's commit), and the result becomes a single-parent commit on the release. The temporary branch is deleted at the end, with or without a conflict.
- **Tasks of a PR**: the issues linked from here (a *remote link* on the issue, pointing at the PR) plus the keys mentioned in the PR's title or branch (`PROJ-7`). The issue's epic plays the role of the backlog item.

## Architecture

Hexagonal: the core defines ports by capability and knows nothing about any platform.

```
server/src
  core/domain      canonical model (PullRequest, Review, WorkItem, ReleaseBranch) and errors
  core/ports       SourceControl, WorkTracking, IdentityProvider
  core/usecases    board, projects, merged/release lanes, release details, task linking
  adapters/azure-devops   SourceControl and WorkTracking over the REST API
  adapters/github         SourceControl over GraphQL (open PRs) and REST
  adapters/jira           WorkTracking over the Jira Cloud REST API
  adapters/entra          IdentityProvider (authorization code + PKCE)
  adapters/memory         the same contracts in memory (demo and tests)
  adapters/session        sessions encrypted on disk
  adapters/http           Fastify routes
  registry.ts      picks the adapters for each session
web/src            React + Tailwind
```

To add another platform: implement the matching port under `adapters/`, register it in `registry.ts` and, for token sign-in, in `adapters/http/patProviders.ts`. GitHub and Jira only support personal access tokens; their OAuth sign-in doesn't exist yet.

## What hasn't been tested against the real APIs

The GitHub and Jira adapters and the Azure DevOps write paths are covered only by simulated responses.
