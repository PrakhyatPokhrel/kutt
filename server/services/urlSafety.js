const dns = require("node:dns").promises;
const net = require("node:net");

const env = require("../env");

/**
 * Check whether an IPv4 or IPv6 address belongs to a loopback, private, or link-local range.
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIp(ip) {
  if (!ip) return true;
  const normalized = ip.replace(/^::ffff:/i, "").toLowerCase();

  if (normalized === "::1" || normalized === "::" || normalized === "0.0.0.0") {
    return true;
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")) {
    return true;
  }

  if (net.isIPv4(normalized)) {
    const parts = normalized.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }

  return false;
}

/**
 * Validate an outbound URL (webhooks / link health checks) against protocol and SSRF rules.
 * @param {string} rawUrl
 * @param {{ allowPrivate?: boolean, skipDns?: boolean }} [options]
 * @returns {Promise<URL>}
 */
async function validateOutboundUrl(rawUrl, options = {}) {
  const allowPrivate = options.allowPrivate ?? env.ALLOW_PRIVATE_WEBHOOKS;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL format.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https protocols are allowed.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!allowPrivate) {
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
      throw new Error("Private or loopback addresses are not allowed.");
    }
    if (net.isIP(hostname) && isPrivateIp(hostname)) {
      throw new Error("Private or loopback IP addresses are not allowed.");
    }
    if (!options.skipDns && !net.isIP(hostname)) {
      try {
        const records = await dns.lookup(hostname, { all: true });
        if (records.some(r => isPrivateIp(r.address))) {
          throw new Error("URL resolves to a private or loopback IP address.");
        }
      } catch (err) {
        if (err.message.includes("private or loopback")) throw err;
        // DNS failure during registration is handled at delivery time, or rejected if unresolvable
      }
    }
  }

  return parsed;
}

module.exports = {
  isPrivateIp,
  validateOutboundUrl,
};
