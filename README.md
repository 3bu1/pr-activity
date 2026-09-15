# Campaign Command Center

A generic, approval-gated marketing operations app. GPT produces campaign strategy; an executor model produces a validated connector payload; the server publishes only after explicit approval and budget checks.

The app is intentionally safe by default:

- **Simulation mode** is the default. It records exactly what would be sent but does not call an ad platform.
- The browser never receives OpenAI keys or channel tokens.
- Connectors hold a **secret reference** (such as `MARKETING_META_TOKEN`), never a secret value.
- A live run requires an approved campaign, `ENABLE_LIVE_CONNECTORS=true`, a configured token environment variable, an explicit `RUN` confirmation, and the configured daily budget cap.

## Run locally

```bash
cp .env.example .env
npm test
npm run dev
```

Open `http://localhost:3000`.

No package installation is required; the app uses Node's built-in HTTP server and `fetch`.

## Workflow

1. Add a sellable product or service, its price/margin, target customer, and proof.
2. Create a campaign brief and ask **GPT** to create the strategy and creative brief.
3. Review it. Approval freezes the commercial brief and records who approved it.
4. Ask the **Codex executor** to produce a strict, connector-safe payload.
5. Run in simulation first. Enable a live connector only after configuring its API base URL and secret reference.
6. Record sales and feedback; use the dashboard to compare revenue, CAC, and feedback themes.

## Generic connector contract

The live generic REST connector sends a JSON `POST` to:

```text
{apiBaseUrl}/campaigns
Authorization: Bearer ${SECRET_REFERENCE}
```

with the validated campaign payload. Real channel adapters usually need provider-specific OAuth, endpoints, schemas, and webhooks. Implement those as adapter modules before connecting a production advertising account; do not assume the generic route matches a provider API.

## Production checklist

- Set `APP_ADMIN_TOKEN`, terminate TLS at a trusted proxy, and place the app behind real user authentication/roles.
- Use a managed secret vault rather than process environment variables for production credentials.
- Replace the JSON file store with Postgres before multiple operators or concurrent campaign use.
- Add provider-specific OAuth callbacks, webhook verification, order/CRM ingestion, and billing-aware budget controls.
- Keep live mode disabled until conversion tracking and fulfilment are verified.
