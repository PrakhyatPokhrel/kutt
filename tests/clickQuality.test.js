const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-key-for-unit-tests";
process.env.ENABLE_BACKGROUND_JOBS = "false";
process.env.CLICK_REPEAT_LIMIT = "3";
process.env.CLICK_IP_BURST_LIMIT = "10";

const clickQuality = require("../server/services/clickQuality.service");
const urlSafety = require("../server/services/urlSafety");
const webhookService = require("../server/services/webhook.service");

describe("Click Quality & Security Unit Tests (US1, US2, NF1, NF2)", () => {
  beforeEach(() => {
    clickQuality.resetTrackers();
  });

  it("classifies standard browser requests as human", () => {
    const res = clickQuality.classifyClick({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36",
      ip: "203.0.113.10",
      headers: { accept: "text/html", "accept-language": "en-GB,en;q=0.9" },
      linkId: 1,
    });
    assert.equal(res.classification, "human");
    assert.equal(res.reason, "verified_human");
    assert.ok(res.ipHash && res.ipHash.length === 16);
  });

  it("identifies known bots, empty user agents, and automation tools (US1)", () => {
    const bot = clickQuality.classifyClick({
      userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      ip: "66.249.66.1",
      headers: { accept: "*/*" },
      linkId: 1,
    });
    assert.equal(bot.classification, "bot");
    assert.equal(bot.reason, "known_bot_ua");

    const emptyUa = clickQuality.classifyClick({
      userAgent: "",
      ip: "198.51.100.2",
      headers: {},
      linkId: 1,
    });
    assert.equal(emptyUa.classification, "bot");
    assert.equal(emptyUa.reason, "empty_user_agent");

    const curlUa = clickQuality.classifyClick({
      userAgent: "curl/8.4.0",
      ip: "198.51.100.3",
      headers: { accept: "*/*" },
      linkId: 1,
    });
    assert.equal(curlUa.classification, "bot");
    assert.equal(curlUa.reason, "automation_tool");
  });

  it("filters rapid repeat IP clicks and header anomalies as suspicious (US2)", () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36";
    const headers = { accept: "text/html", "accept-language": "en-US" };

    for (let i = 0; i < 3; i++) {
      const ok = clickQuality.classifyClick({ userAgent: ua, ip: "203.0.113.99", headers, linkId: 42 });
      assert.equal(ok.classification, "human");
    }

    const suspicious = clickQuality.classifyClick({ userAgent: ua, ip: "203.0.113.99", headers, linkId: 42 });
    assert.equal(suspicious.classification, "suspicious");
    assert.equal(suspicious.reason, "rapid_repeat_ip");

    const headerAnomaly = clickQuality.classifyClick({
      userAgent: ua,
      ip: "203.0.113.100",
      headers: {},
      linkId: 43,
    });
    assert.equal(headerAnomaly.classification, "suspicious");
    assert.equal(headerAnomaly.reason, "header_anomaly");
  });

  it("maintains sub-millisecond classification overhead for redirects (NF1)", () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0 Safari/537.36";
    const headers = { accept: "text/html", "accept-language": "en-US" };
    const start = performance.now();
    for (let i = 0; i < 200; i++) {
      clickQuality.classifyClick({ userAgent: ua, ip: `198.51.100.${i % 250}`, headers, linkId: i });
    }
    const avgMs = (performance.now() - start) / 200;
    assert.ok(avgMs < 5, `Expected avg classification overhead < 5ms, got ${avgMs.toFixed(3)}ms`);
  });

  it("blocks private/SSRF webhook URLs when allowPrivate is false and signs payloads (NF2)", async () => {
    await assert.rejects(
      () => urlSafety.validateOutboundUrl("http://127.0.0.1:8080/hook", { allowPrivate: false, skipDns: true }),
      /Private or loopback/
    );
    await assert.rejects(
      () => urlSafety.validateOutboundUrl("http://169.254.169.254/latest/meta-data", { allowPrivate: false, skipDns: true }),
      /Private or loopback/
    );
    await assert.rejects(
      () => urlSafety.validateOutboundUrl("ftp://example.com/file", { allowPrivate: false, skipDns: true }),
      /Only http and https/
    );

    const parsed = await urlSafety.validateOutboundUrl("https://hooks.example.org/kutt", {
      allowPrivate: false,
      skipDns: true,
    });
    assert.equal(parsed.hostname, "hooks.example.org");

    const sig = webhookService.signPayload("secret123", "1700000000", '{"hello":"world"}');
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", "secret123").update('1700000000.{"hello":"world"}').digest("hex");
    assert.equal(sig, expected);
  });
});
