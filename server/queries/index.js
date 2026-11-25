const alert = require("./alert.queries");
const clickEvent = require("./clickEvent.queries");
const domain = require("./domain.queries");
const visit = require("./visit.queries");
const link = require("./link.queries");
const user = require("./user.queries");
const host = require("./host.queries");
const webhook = require("./webhook.queries");

module.exports = {
  alert,
  clickEvent,
  domain,
  host,
  link,
  user,
  visit,
  webhook,
};
