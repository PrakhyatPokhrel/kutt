# Click Quality & Traffic Intelligence — Architecture & API Guide

**Module:** CN7021 Advanced Software Engineering (Group E — `LinkClick`)  
**Base System:** Kutt v3.2.6 (`thedevs-network/kutt`)  
**Student / Group Leader:** Prakhyat Pokhrel (`3286609`)

---

## 1. Overview

This extension adds **Click Quality and Traffic Intelligence** to Kutt without adding blocking overhead to short-link redirects:

- **US1 — Bot Detection:** Classifies automated bots (`isbot` signatures, empty User-Agent, CLI/headless automation tools) separately from real human visitors.
- **US2 — Suspicious Click Filtering:** Sliding-window detector filters rapid repeat clicks from the same IP hash, global IP bursts, and browser-header anomalies from `visit_count` and `visits`.
- **US3 — Anomaly Alerts:** Detects traffic spikes (`traffic_spike`) and automated traffic surges (`bot_surge`), persisting alerts in `traffic_alerts`.
- **US4 & NF3 — Signed Webhooks with Retries & Logging:** Dispatches HMAC-SHA256 signed webhook payloads (`X-Kutt-Signature`) and retries failed deliveries with exponential backoff, logging every attempt in `webhook_deliveries`.
- **US5 — Destination Link Health Monitoring:** Checks target URLs on-demand or via background cron, marking unreachable/4xx/5xx targets as `broken` and raising `link_broken` alerts.
- **US6 — Admin Observability Metrics:** Exposes `/api/v2/metrics` in JSON and Prometheus text formats.
- **NF1 — Minimal Redirect Latency:** Hot-path click classification runs strictly in-memory in `< 1 ms`; all database writes, anomaly checks, and webhooks execute asynchronously.
- **NF2 — Security:** Private/loopback SSRF protection on outbound webhook and health-check URLs, masked webhook secrets, and strict admin authentication on `/api/v2/metrics`.
- **NF4 — Automated Testing:** Covered by unit and end-to-end tests (`npm test`).

---

## 2. Architecture Flow

```mermaid
flowchart LR
  C["Visitor / Client"] -->|GET /:id| R["links.redirect"]
  R -->|O(1) in-memory| CQ["clickQuality.classifyClick"]
  R -->|302 Redirect immediately| C
  CQ -->|async enqueue| Q["queues/visit.js"]
  Q -->|all clicks| CE["click_events + bot/suspicious counters"]
  Q -->|human only| V["links.visit_count + visits"]
  Q -->|async check| AN["anomaly.evaluateClickAnomaly"]
  AN -->|threshold exceeded| AL["traffic_alerts"]
  AN --> WH["webhook.dispatchEvent"]
  LH["linkHealth.checkLinkHealth"] -->|broken| AL
  LH -->|broken| WH
  WH -->|HMAC-SHA256 + backoff retry| WD["webhook_deliveries"]
```

---

## 3. Interface Contracts (SCRUM-9)

### 3.1 Click Record Fields (`click_events`)

| Field | Type | Description |
| --- | --- | --- |
| `link_id` | integer (FK) | Referenced shortened link ID |
| `user_id` | integer (FK) | Link owner ID |
| `classification` | string | `"human"`, `"bot"`, or `"suspicious"` |
| `reason` | string | `"verified_human"`, `"empty_user_agent"`, `"automation_tool"`, `"known_bot_ua"`, `"rapid_repeat_ip"`, `"ip_burst"`, or `"header_anomaly"` |
| `ip_hash` | string | 16-char HMAC-SHA256 truncated hash of visitor IP |
| `user_agent` | string | Raw User-Agent header (truncated to 1024 chars) |
| `browser` / `os` | string | Parsed browser and OS |
| `country` / `referrer` | string | GeoIP country code and normalized referrer |
| `latency_ms` | float | Synchronous classification time in milliseconds |
| `created_at` | datetime | UTC timestamp |

### 3.2 Webhook Alert Event Payload

Headers included on every `POST` delivery:
- `X-Kutt-Event`: `traffic_spike` | `bot_surge` | `link_broken` | `webhook.test`
- `X-Kutt-Delivery`: delivery UUID
- `X-Kutt-Timestamp`: Unix epoch seconds
- `X-Kutt-Signature`: `sha256=<HMAC-SHA256(secret, "${timestamp}.${rawBody}")>`

```json
{
  "id": "delivery-uuid",
  "event": "traffic_spike",
  "timestamp": "2026-11-25T10:00:00.000Z",
  "data": {
    "alert_id": "alert-uuid",
    "alert_type": "traffic_spike",
    "severity": "warning",
    "message": "Traffic spike detected on /abc123: 12 clicks in the last minute.",
    "link_id": "link-uuid",
    "link_address": "abc123",
    "target": "https://example.org/ok",
    "clicks_per_minute": 12,
    "threshold": 10
  }
}
```

---

## 4. API Endpoints

All endpoints accept either `X-API-Key` header or authenticated `token` session cookie.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v2/links/:id/click-quality` | Owner / Admin | Summary counts (`human`, `bot`, `suspicious`), reason breakdown, recent events, health status |
| `POST` | `/api/v2/links/:id/health-check` | Owner / Admin | Trigger immediate destination health check |
| `GET` | `/api/v2/alerts` | Owner / Admin | List alerts (`?acknowledged=false&alert_type=traffic_spike`) |
| `POST` | `/api/v2/alerts/:id/acknowledge` | Owner / Admin | Acknowledge an alert |
| `GET` | `/api/v2/webhooks` | Owner / Admin | List registered webhooks (secrets masked) |
| `POST` | `/api/v2/webhooks` | Owner / Admin | Register webhook (`url`, `events`, optional `secret`) |
| `PATCH` | `/api/v2/webhooks/:id` | Owner / Admin | Enable/disable or update webhook |
| `DELETE` | `/api/v2/webhooks/:id` | Owner / Admin | Delete webhook |
| `POST` | `/api/v2/webhooks/:id/test` | Owner / Admin | Send a signed test delivery |
| `GET` | `/api/v2/webhooks/:id/deliveries` | Owner / Admin | Inspect delivery attempts, status codes, errors, retry state |
| `GET` | `/api/v2/metrics` | **Admin only** | Service observability metrics (JSON or `?format=prometheus`) |

---

## 5. Local Setup & Verification

```bash
cp .example.env .env
# Set JWT_SECRET in .env
npm install
npm run migrate
npm test
npm start
```
