const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const testDbPath = path.join(__dirname, `.tmp-test-${process.pid}.sqlite`);
process.env.NODE_ENV = "test";
process.env.DB_CLIENT = "better-sqlite3";
process.env.DB_FILENAME = testDbPath;
process.env.JWT_SECRET = "e2e-test-jwt-secret-key-123456";
process.env.REDIS_ENABLED = "false";
process.env.DISALLOW_REGISTRATION = "false";
process.env.ENABLE_BACKGROUND_JOBS = "false";
process.env.ALLOW_PRIVATE_WEBHOOKS = "true";
process.env.CLICK_REPEAT_LIMIT = "3";
process.env.SPIKE_THRESHOLD_PER_MIN = "5";
process.env.WEBHOOK_RETRY_BASE_MS = "10";
process.env.WEBHOOK_MAX_ATTEMPTS = "3";

const knex = require("../server/knex");
const app = require("../server/server");
const services = require("../server/services");

const sleep = ms => new Promise(r => setTimeout(r, ms));

describe("Kutt Click Quality & Traffic Intelligence E2E (US1-US6, NF1-NF4)", () => {
  let server;
  let baseUrl;
  let targetServer;
  let targetBaseUrl;
  let webhookServer;
  let webhookBaseUrl;

  let webhookFailNext = 0;
  const receivedWebhooks = [];

  let adminApiKey;
  let adminToken;
  let userApiKey;
  let userToken;
  let linkUuid;
  let linkAddress;
  let brokenLinkUuid;
  let webhookId;
  let webhookSecret;

  before(async () => {
    await knex.migrate.latest({
      directory: path.join(__dirname, "../server/migrations"),
    });

    // Mock target website for redirect & link health checks (US5)
    targetServer = http.createServer((req, res) => {
      if (req.url === "/missing") {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>OK</body></html>");
    });
    await new Promise(resolve => targetServer.listen(0, "127.0.0.1", resolve));
    targetBaseUrl = `http://127.0.0.1:${targetServer.address().port}`;

    // Mock webhook receiver supporting simulated transient failures (US4, NF3)
    webhookServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", chunk => {
        body += chunk;
      });
      req.on("end", () => {
        if (webhookFailNext > 0) {
          webhookFailNext -= 1;
          res.writeHead(500);
          res.end("Simulated Receiver Error");
          return;
        }
        receivedWebhooks.push({
          headers: req.headers,
          rawBody: body,
          json: JSON.parse(body),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise(resolve => webhookServer.listen(0, "127.0.0.1", resolve));
    webhookBaseUrl = `http://127.0.0.1:${webhookServer.address().port}`;

    server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => targetServer.close(resolve));
    await new Promise(resolve => webhookServer.close(resolve));
    await knex.destroy();
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("sets up admin and standard user accounts with API keys", async () => {
    const adminRes = await fetch(`${baseUrl}/api/v2/auth/create-admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: "admin@linkclick.test", password: "Password123!" }),
    });
    assert.equal(adminRes.status, 201);

    const adminLoginRes = await fetch(`${baseUrl}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: "admin@linkclick.test", password: "Password123!" }),
    });
    assert.equal(adminLoginRes.status, 200);
    adminToken = (await adminLoginRes.json()).token;

    const adminKeyRes = await fetch(`${baseUrl}/api/v2/auth/apikey`, {
      method: "POST",
      headers: { Cookie: `token=${adminToken}`, Accept: "application/json" },
    });
    assert.equal(adminKeyRes.status, 201);
    adminApiKey = (await adminKeyRes.json()).apikey;

    // Create a non-admin verified user via admin endpoint
    const userRes = await fetch(`${baseUrl}/api/v2/users/admin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-API-Key": adminApiKey,
      },
      body: JSON.stringify({
        email: "owner@linkclick.test",
        password: "Password123!",
        verified: true,
        role: "USER",
      }),
    });
    assert.equal(userRes.status, 201);

    const loginRes = await fetch(`${baseUrl}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: "owner@linkclick.test", password: "Password123!" }),
    });
    assert.equal(loginRes.status, 200);
    userToken = (await loginRes.json()).token;

    const userKeyRes = await fetch(`${baseUrl}/api/v2/auth/apikey`, {
      method: "POST",
      headers: { Cookie: `token=${userToken}`, Accept: "application/json" },
    });
    assert.equal(userKeyRes.status, 201);
    userApiKey = (await userKeyRes.json()).apikey;
    assert.ok(userApiKey && adminApiKey);
  });

  it("registers a webhook, signs deliveries, and retries failed attempts (US4, NF2, NF3)", async () => {
    const createRes = await fetch(`${baseUrl}/api/v2/webhooks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-API-Key": userApiKey,
      },
      body: JSON.stringify({
        url: `${webhookBaseUrl}/events`,
        events: ["traffic_spike", "bot_surge", "link_broken", "webhook.test"],
      }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    webhookId = created.id;
    webhookSecret = created.secret;
    assert.ok(webhookId && webhookSecret.startsWith("whsec_"));

    // Listing webhooks hides raw secret (NF2)
    const listRes = await fetch(`${baseUrl}/api/v2/webhooks`, {
      headers: { Accept: "application/json", "X-API-Key": userApiKey },
    });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.data.length, 1);
    assert.equal(listBody.data[0].secret, undefined);

    // Simulate 1st attempt returning HTTP 500, then retry succeeding with HTTP 200
    webhookFailNext = 1;
    const testRes = await fetch(`${baseUrl}/api/v2/webhooks/${webhookId}/test`, {
      method: "POST",
      headers: { Accept: "application/json", "X-API-Key": userApiKey },
    });
    assert.equal(testRes.status, 200);
    const { delivery: firstAttempt } = await testRes.json();
    assert.equal(firstAttempt.status, "pending");
    assert.equal(firstAttempt.attempts, 1);
    assert.equal(firstAttempt.last_status_code, 500);

    await sleep(30);
    const retried = await services.webhook.processPendingRetries();
    assert.equal(retried.length, 1);
    assert.equal(retried[0].status, "success");
    assert.equal(retried[0].attempts, 2);
    assert.equal(retried[0].last_status_code, 200);

    // Verify HMAC signature on received webhook
    const delivered = receivedWebhooks.at(-1);
    assert.ok(delivered);
    const expectedSig =
      "sha256=" +
      crypto
        .createHmac("sha256", webhookSecret)
        .update(`${delivered.headers["x-kutt-timestamp"]}.${delivered.rawBody}`)
        .digest("hex");
    assert.equal(delivered.headers["x-kutt-signature"], expectedSig);

    // Delivery log endpoint shows the recorded delivery (NF3)
    const logsRes = await fetch(`${baseUrl}/api/v2/webhooks/${webhookId}/deliveries`, {
      headers: { Accept: "application/json", "X-API-Key": userApiKey },
    });
    assert.equal(logsRes.status, 200);
    const logsBody = await logsRes.json();
    assert.equal(logsBody.data[0].status, "success");
  });

  it("filters bot and suspicious clicks while tracking human visits and spike alerts (US1, US2, US3)", async () => {
    const createLinkRes = await fetch(`${baseUrl}/api/v2/links`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-API-Key": userApiKey,
      },
      body: JSON.stringify({ target: "https://example.org/ok", description: "Click Quality Test" }),
    });
    assert.equal(createLinkRes.status, 201);
    const createdLink = await createLinkRes.json();
    linkUuid = createdLink.id;
    linkAddress = createdLink.address;

    const humanUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36";

    // 1. Human visit
    const r1 = await fetch(`${baseUrl}/${linkAddress}`, {
      redirect: "manual",
      headers: { "User-Agent": humanUa, Accept: "text/html", "Accept-Language": "en-GB" },
    });
    assert.equal(r1.status, 302);

    // 2. Two bot visits (Googlebot + curl)
    await fetch(`${baseUrl}/${linkAddress}`, {
      redirect: "manual",
      headers: { "User-Agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" },
    });
    await fetch(`${baseUrl}/${linkAddress}`, {
      redirect: "manual",
      headers: { "User-Agent": "curl/8.4.0" },
    });

    // 3. Rapid repeat clicks from same IP -> pushes past CLICK_REPEAT_LIMIT=3 AND triggers SPIKE_THRESHOLD_PER_MIN=5
    for (let i = 0; i < 4; i++) {
      await fetch(`${baseUrl}/${linkAddress}`, {
        redirect: "manual",
        headers: { "User-Agent": humanUa, Accept: "text/html", "Accept-Language": "en-GB" },
      });
    }

    // Wait briefly for async visit processor & webhook dispatch
    await sleep(120);

    const cqRes = await fetch(`${baseUrl}/api/v2/links/${linkUuid}/click-quality`, {
      headers: { Accept: "application/json", "X-API-Key": userApiKey },
    });
    assert.equal(cqRes.status, 200);
    const cq = await cqRes.json();

    assert.equal(cq.counters.human, 3); // 1st + 2 more before limit=3 exceeded
    assert.equal(cq.counters.bot, 2);
    assert.equal(cq.counters.suspicious, 2); // 4th and 5th human-UA clicks from same IP
    assert.ok(cq.events.length >= 7);

    // Verify traffic_spike alert was generated (US3) and can be acknowledged
    const alertsRes = await fetch(`${baseUrl}/api/v2/alerts?alert_type=traffic_spike`, {
      headers: { Accept: "application/json", "X-API-Key": userApiKey },
    });
    assert.equal(alertsRes.status, 200);
    const alertsBody = await alertsRes.json();
    assert.ok(alertsBody.data.length >= 1);
    const spikeAlert = alertsBody.data[0];
    assert.equal(spikeAlert.acknowledged, false);

    const ackRes = await fetch(`${baseUrl}/api/v2/alerts/${spikeAlert.uuid}/acknowledge`, {
      method: "POST",
      headers: { Accept: "application/json", "X-API-Key": userApiKey },
    });
    assert.equal(ackRes.status, 200);
    const ackBody = await ackRes.json();
    assert.equal(ackBody.alert.acknowledged, true);

    // Verify traffic_spike webhook was received
    assert.ok(receivedWebhooks.some(w => w.json.event === "traffic_spike"));
  });

  it("monitors destination link health and alerts on broken links (US5)", async () => {
    // Route health-check URLs for *.example.org to our local mock targetServer over real HTTP
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const urlStr = typeof input === "string" ? input : input.url;
      if (urlStr.startsWith("https://example.org/")) {
        return originalFetch(urlStr.replace("https://example.org", targetBaseUrl), init);
      }
      return originalFetch(input, init);
    };

    try {
      const healthyCheck = await fetch(`${baseUrl}/api/v2/links/${linkUuid}/health-check`, {
        method: "POST",
        headers: { Accept: "application/json", "X-API-Key": userApiKey },
      });
      assert.equal(healthyCheck.status, 200);
      assert.equal((await healthyCheck.json()).health_status, "healthy");

      const brokenRes = await fetch(`${baseUrl}/api/v2/links`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-API-Key": userApiKey,
        },
        body: JSON.stringify({ target: "https://example.org/missing" }),
      });
      assert.equal(brokenRes.status, 201);
      brokenLinkUuid = (await brokenRes.json()).id;

      const checkBroken = await fetch(`${baseUrl}/api/v2/links/${brokenLinkUuid}/health-check`, {
        method: "POST",
        headers: { Accept: "application/json", "X-API-Key": userApiKey },
      });
      assert.equal(checkBroken.status, 200);
      const brokenBody = await checkBroken.json();
      assert.equal(brokenBody.health_status, "broken");
      assert.equal(brokenBody.last_status_code, 404);

      await sleep(50);
      assert.ok(receivedWebhooks.some(w => w.json.event === "link_broken"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("protects admin observability metrics and serves JSON & Prometheus formats (US6, NF2)", async () => {
    const unauth = await fetch(`${baseUrl}/api/v2/metrics`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(unauth.status, 401);

    const nonAdmin = await fetch(`${baseUrl}/api/v2/metrics`, {
      headers: { Accept: "application/json", "X-API-Key": userApiKey },
    });
    assert.equal(nonAdmin.status, 401);

    const adminJson = await fetch(`${baseUrl}/api/v2/metrics`, {
      headers: { Accept: "application/json", "X-API-Key": adminApiKey },
    });
    assert.equal(adminJson.status, 200);
    const metricsJson = await adminJson.json();
    assert.equal(metricsJson.links.broken, 1);
    assert.equal(metricsJson.clicks.human_visits, 3);
    assert.equal(metricsJson.clicks.bot_filtered, 2);
    assert.equal(metricsJson.clicks.suspicious_filtered, 2);

    const adminProm = await fetch(`${baseUrl}/api/v2/metrics?format=prometheus`, {
      headers: { "X-API-Key": adminApiKey },
    });
    assert.equal(adminProm.status, 200);
    const promText = await adminProm.text();
    assert.match(promText, /kutt_clicks_total\{classification="human"\} 3/);
    assert.match(promText, /kutt_links_broken_total 1/);
  });

  it("renders Handlebars UI panels for stats, settings webhooks/alerts, and admin metrics", async () => {
    const statsHtmlRes = await fetch(`${baseUrl}/api/v2/links/${linkUuid}/stats`, {
      headers: { Accept: "text/html", Cookie: `token=${userToken}` },
    });
    assert.equal(statsHtmlRes.status, 200);
    const statsHtml = await statsHtmlRes.text();
    assert.match(statsHtml, /Human Visits/);
    assert.match(statsHtml, /Bots Filtered/);
    assert.match(statsHtml, /Suspicious Filtered/);

    const settingsRes = await fetch(`${baseUrl}/settings`, {
      headers: { Accept: "text/html", Cookie: `token=${userToken}` },
    });
    assert.equal(settingsRes.status, 200);
    assert.match(await settingsRes.text(), /id="webhooks-wrapper"/);

    const webhooksHtmlRes = await fetch(`${baseUrl}/api/webhooks`, {
      headers: { Accept: "text/html", Cookie: `token=${userToken}` },
    });
    assert.equal(webhooksHtmlRes.status, 200);
    assert.match(await webhooksHtmlRes.text(), /Webhooks &amp; Traffic Intelligence/);

    const adminMetricsHtmlRes = await fetch(`${baseUrl}/api/metrics`, {
      headers: { Accept: "text/html", Cookie: `token=${adminToken}` },
    });
    assert.equal(adminMetricsHtmlRes.status, 200);
    assert.match(await adminMetricsHtmlRes.text(), /Service Observability/);
  });
});
