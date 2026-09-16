# PR Activity

Local campaign operations application with PostgreSQL, user accounts, business
permissions, and durable background jobs. Live advertising/publishing adapters
are not enabled in this build. Review and simulation work without platform
credentials or an AI key.

## Local Review

The current workspace has `.env.local` configured and a PostgreSQL container named
`pr-activity-postgres` on loopback port `55470`. Start that existing database with
`docker start pr-activity-postgres`, then:

```sh
npm ci
npm run local
```

Open http://localhost:3012 and create an account. Registration is enabled by the
local configuration. The email is a login name; no email is sent. Create a business,
add an offer, then create a campaign. Plan -> approve -> prepare -> run uses the
background worker. Run produces a clearly identified simulation.

On a fresh machine, use `compose.local.yml` instead of the existing container:

```sh
cp .env.local.example .env.local
docker compose -f compose.local.yml up -d
npm ci
npm run local
```

Do not start both database options on the same port. Node 24 and Docker are
required. The example credentials are development-only.

## Implemented

- PostgreSQL stores accounts, hashed sessions, businesses, memberships, individual
  offer/campaign/feedback/connector/audit records, jobs, and worker health.
- Passwords use salted scrypt. Sessions expire after eight hours and use HttpOnly,
  SameSite cookies; HTTPS origins also set Secure. Logout revokes the session.
- Authentication, same-origin checks, and shared database rate limits protect API
  writes, login, and AI requests across server processes.
- Business creators are owners. Owners grant editor/viewer access to existing
  accounts and revoke access. Owners approve and run campaigns and manage
  connectors; editors prepare work and record results; viewers can read.
- Database requests load only the selected authorized business. Currency totals,
  connectors, audit history, and job lists remain business-specific.
- Profile defaults feed campaign planning with explicit campaign overrides.
  Planning snapshots brand settings; approval retains those settings afterward.
- pg-boss persists action jobs in the same transaction as the application job
  record. Duplicate pending submissions return the existing job. Transient
  failures retry; permission/state failures appear to the operator. Workers
  recheck access. Scheduled jobs can be cancelled before execution.
- Campaign updates and successful job completion commit together. External
  exactly-once delivery is not claimed.
- `/api/health` checks PostgreSQL. `/api/ready` also checks worker heartbeat.
  Errors include request IDs; logs omit credentials and request bodies.

## Verification

```sh
npm test
npm run test:database
npm audit --omit=dev --audit-level=high
docker build -t pr-activity:local .
```

The database test creates and drops an isolated temporary database using
`TEST_DATABASE_URL`; the account needs CREATEDB. Without that variable, `npm test`
explicitly skips this suite. CI runs all suites with PostgreSQL. Coverage includes
authentication, CSRF rejection, business isolation, roles, queue persistence,
duplicate submissions, cancellation, and the campaign flow.

## Operation And Recovery

`npm run local` starts web and worker and stops both on Ctrl-C. Independent
processes can run `npm start` and `npm run worker` with the same DATABASE_URL.
`npm run migrate` applies ordered transactional SQL migrations. Back up before
schema changes; an old application image is not a database rollback strategy.

To create an account with registration disabled, or recover a password:

```sh
read -rs PR_PASSWORD
export PR_PASSWORD
node --env-file=.env.local scripts/user.mjs create user@example.com
# Use reset instead of create to change a password and revoke its sessions.
unset PR_PASSWORD
```

Back up the existing local container:

```sh
docker exec pr-activity-postgres pg_dump -U pr_activity -d pr_activity -Fc -f /tmp/pr-activity.dump
docker cp pr-activity-postgres:/tmp/pr-activity.dump ./pr-activity.dump
```

Encrypt dumps and keep them outside source control. Restore to a new empty database
with `pg_restore --no-owner --no-privileges`; run migrations and verify records,
login, and jobs before switching the app. Do not restore over the live database.
The PostgreSQL volume survives restarts; `docker compose down -v` deletes it.

## Before Internet Deployment

Deployment is deferred for local review. Configure HTTPS, unique database
credentials, disable public signup, choose account provisioning/email verification
and recovery policy, configure encrypted backups and monitoring, and validate the
deployment's restore procedure and concurrency limits.

Provider-specific OAuth, publishing APIs, webhooks, uploaded media/object storage,
automatic conversion ingestion, and measured optimization remain product work.
Connectors describe adapter configuration; they are not working Meta/Google/LinkedIn
publishing adapters. Database mode refuses live execution.

Without DATABASE_URL, the earlier JSON prototype remains available for regression
tests. It is not a production mode. `NODE_ENV=production` requires PostgreSQL and
an HTTPS APP_ORIGIN. Existing JSON data is not silently imported into an account;
import only after choosing its authorized owner.

## Technical References

Transactions follow the [node-postgres contract](https://node-postgres.com/features/transactions).
Durable job processing uses [pg-boss](https://pgboss.io/) with PostgreSQL.
