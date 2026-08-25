#!/usr/bin/env node
// Spotonix inbound signup auto-classifier.
// Finds new website-signup contacts in HubSpot (web analytics sources) that lack
// inbound_signup_type, classifies them by their URL trail, tags them, adds them to the
// "GTM - Inbound Website Signups" static list, and enrolls them in the Instantly
// "Spotonix Inbound Follow-up" campaign with per-signup-type copy.
//
// Runs in GitHub Actions alongside sync-to-hubspot.mjs (own state dir + cache).
// Safe to run frequently: idempotent via state.json + HubSpot property check.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = process.env.SPOTONIX_HS_SYNC_DIR || path.join(os.homedir(), ".spotonix-hs-sync");
fs.mkdirSync(DIR, { recursive: true });
const STATE = path.join(DIR, "state.json");

const cfg = (process.env.HUBSPOT_TOKEN && process.env.INSTANTLY_KEY)
  ? { hubspotToken: process.env.HUBSPOT_TOKEN, instantlyKey: process.env.INSTANTLY_KEY }
  : (() => { const c = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8")); return { hubspotToken: c.hubspotToken, instantlyKey: c.instantlyKey }; })();
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
state.enrolled ??= {};

const SLEEP_MS = process.env.SYNC_FAST === "1" ? 20 : 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HS_BASE = "https://api.hubapi.com/crm/v3";
const HS_LIST_ID = process.env.HS_INBOUND_LIST_ID || "24";
const INST_URL = "https://mcp.instantly.ai/mcp";
const INBOUND_CAMPAIGN_ID = process.env.INSTANTLY_INBOUND_CAMPAIGN_ID || "f586fa24-4803-4d02-980e-b8217c697887";

// ---------- filters ----------
const INTERNAL_DOMAINS = ["spotonix.com", "clea.design", "innerzeal.com"];
const DISPOSABLE_DOMAINS = [
  "mailinator", "toilet.com", "tempmail", "temp-mail", "10minutemail", "guerrillamail",
  "yopmail", "trashmail", "sharklasers", "dispostable", "fakeinbox", "getnada",
];

function isJunk(email) {
  if (!email) return true;
  const domain = email.split("@")[1]?.toLowerCase() || "";
  if (INTERNAL_DOMAINS.some((d) => domain === d || domain.endsWith("." + d))) return true;
  if (DISPOSABLE_DOMAINS.some((d) => domain.includes(d))) return true;
  return false;
}

function classify(firstUrl, lastUrl) {
  const u = `${firstUrl || ""} ${lastUrl || ""}`.toLowerCase();
  if (u.includes("meetings.hubspot.com")) return "meeting_attempt";
  if (u.includes("/demo")) return "demo_request";
  if (u.includes("whitepaper")) return "whitepaper";
  if (u.includes("/product") || u.includes("how-it-works")) return "product_interest";
  return "general_visitor";
}

function deriveName(contact) {
  if (contact.properties.firstname) {
    const ln = contact.properties.lastname || "";
    return { first: contact.properties.firstname, last: ln };
  }
  const local = (contact.properties.email || "").split("@")[0] || "there";
  const seg = local.split(/[._-]/)[0].replace(/[0-9]+$/, "");
  const first = seg.charAt(0).toUpperCase() + seg.slice(1);
  const seg2 = local.split(/[._-]/)[1];
  const last = seg2 ? seg2.replace(/[0-9]+$/, "").charAt(0).toUpperCase() + seg2.replace(/[0-9]+$/, "").slice(1) : "";
  return { first, last };
}

// ---------- copy templates (per signup type, spotonix-copy skill compliant) ----------
const BUILD = "Spotonix lets users ask data questions in plain English, shows the plan before anything runs, and grounds every answer in the definitions your team supplies";
const E2 = (n) => `Hey ${n}, following up once. A metric ends up with two definitions and whichever tool is in use quietly picks one. Spotonix asks which definition you mean instead. Open to 20 min to see it live?`;
const E3 = (n) => `Hey ${n}, if now isn't the right time, no worries. If it is, send us your four hardest data problems and we'll set up self-service analytics your team can actually use on Spotonix without analyst time. Reply with a day and I'll send times.`;

function copyFor(type, n) {
  switch (type) {
    case "meeting_attempt":
      return { e1_subject: "the calendar", e1_body: `Hey ${n}, you tried to grab time on my calendar and it didn't go through on my end. Happy to make it happen now. ${BUILD} Got 20 min this week for a demo?` };
    case "demo_request":
      return { e1_subject: "your demo request", e1_body: `Hey ${n}, you reached out about seeing Spotonix. Happy to make that happen. ${BUILD} Got 20 min this week for a demo?` };
    case "whitepaper":
      return { e1_subject: "the whitepaper", e1_body: `Hey ${n}, you grabbed our whitepaper on metric definitions. As more people lean on those answers, keeping everyone on the same definitions gets harder. ${BUILD} Worth 20 min to see it live?` };
    case "product_interest":
      return { e1_subject: "how it works", e1_body: `Hey ${n}, you went through how Spotonix works recently. Seeing it run on your own data is the better version. ${BUILD} Got 20 min this week?` };
    default:
      return { e1_subject: "checking the fit", e1_body: `Hey ${n}, you spent some time on spotonix.com recently. If keeping everyone on the same metric definitions is a real problem for your team, worth a look. ${BUILD} Got 20 min this week?` };
  }
}

// ---------- HubSpot ----------
async function hs(path_, opts = {}) {
  const method = opts.method || "GET";
  const body = opts.body != null ? JSON.stringify(opts.body) : null;
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await sleep(400 * attempt);
    try {
      const res = await fetch(`${HS_BASE}${path_}`, {
        method,
        headers: { Authorization: `Bearer ${cfg.hubspotToken}`, "Content-Type": "application/json" },
        body,
      });
      const text = await res.text();
      if (res.status === 429) { lastErr = new Error("HS 429"); continue; }
      if (!res.ok) throw new Error(`HS ${method} ${path_}: ${res.status} ${text.slice(0, 200)}`);
      return text ? JSON.parse(text) : null;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function findUnclassifiedInbound() {
  const out = [];
  let after = null;
  for (;;) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: "hs_analytics_source", operator: "IN", values: ["DIRECT_TRAFFIC", "ORGANIC_SEARCH", "SOCIAL_MEDIA", "REFERRALS"] },
          { propertyName: "inbound_signup_type", operator: "NOT_HAS_PROPERTY" },
        ],
      }],
      limit: 100,
      properties: ["email", "firstname", "lastname", "company", "createdate", "hs_analytics_first_url", "hs_analytics_last_url"],
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
    };
    if (after) body.after = after;
    const r = await hs("/objects/contacts/search", { method: "POST", body });
    out.push(...r.results);
    if (r.paging?.next?.after && out.length < 500) { after = r.paging.next.after; continue; }
    break;
  }
  return out;
}

async function tagContacts(inputs) {
  // chunks of 100
  for (let i = 0; i < inputs.length; i += 100) {
    await hs("/objects/contacts/batch/update", { method: "POST", body: { inputs: inputs.slice(i, i + 100) } });
    await sleep(SLEEP_MS);
  }
}

async function addToList(recordIds) {
  const res = await fetch(`${HS_BASE}/lists/${HS_LIST_ID}/memberships/add`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${cfg.hubspotToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(recordIds.map(String)),
  });
  if (!res.ok) throw new Error(`list add: ${res.status} ${(await res.text()).slice(0, 150)}`);
}

// ---------- Instantly (MCP JSON-RPC, same transport as sync-to-hubspot.mjs) ----------
let instSession = null;
async function mcpInstantly(tool, args) {
  const call = async () => {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${cfg.instantlyKey}`,
    };
    if (instSession) headers["mcp-session-id"] = instSession;
    return fetch(INST_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    });
  };
  let res, text;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(600 * attempt);
    res = await call();
    const sid = res.headers.get("mcp-session-id");
    if (sid && !instSession) instSession = sid;
    text = await res.text();
    if (text.trim().startsWith("<") || text.trim() === "") continue; // gateway noise, retry
    if (res.status !== 200 && !text.includes('"jsonrpc"')) continue;
    break;
  }
  const msgs = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const last = msgs[msgs.length - 1];
  if (!last) throw new Error(`${tool}: no response (${text.slice(0, 200)})`);
  if (last.error) throw new Error(`${tool}: ${JSON.stringify(last.error)}`);
  const item = (last.result?.content || []).find((c) => c.type === "text");
  try { return item ? JSON.parse(item.text) : last.result; } catch { return item?.text; }
}

async function ensureInstantlySession() {
  if (instSession) return;
  const res = await fetch(INST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${cfg.instantlyKey}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "inbound-classify", version: "1.0" } } }),
  });
  instSession = res.headers.get("mcp-session-id");
  if (!instSession) throw new Error("Instantly initialize did not return a session id");
  await res.text().catch(() => {});
}

// ---------- main ----------
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

try {
  log("start");
  const candidates = await findUnclassifiedInbound();
  log(`found ${candidates.length} unclassified inbound contact(s)`);

  const legit = [];
  const skipped = [];
  for (const c of candidates) {
    if (c.id in state.enrolled) continue; // already handled in a previous run
    if (isJunk(c.properties.email)) {
      // tag as junk so it never resurfaces, but do NOT enroll anywhere
      skipped.push(c);
      continue;
    }
    legit.push(c);
  }

  if (skipped.length) {
      await tagContacts(skipped.map((c) => ({
        id: c.id,
        properties: { inbound_signup_type: "general_visitor", hs_lead_status: "UNQUALIFIED" },
      })));
    for (const c of skipped) state.enrolled[c.id] = "junk";
    log(`tagged+ignored ${skipped.length} junk contact(s)`);
  }

  if (!legit.length) {
    fs.writeFileSync(STATE, JSON.stringify(state));
    log(JSON.stringify({ ok: true, newEnrollments: 0 }));
    process.exit(0);
  }

  // 1. tag signup type + status
  await tagContacts(legit.map((c) => ({
    id: c.id,
    properties: {
      inbound_signup_type: classify(c.properties.hs_analytics_first_url, c.properties.hs_analytics_last_url),
      hs_lead_status: "NEW",
    },
  })));
  log(`tagged ${legit.length}`);

  // 2. add to HubSpot list
  await addToList(legit.map((c) => c.id));
  log(`added ${legit.length} to list ${HS_LIST_ID}`);

  // 3. enroll in Instantly follow-up campaign
  await ensureInstantlySession();
  const leads = legit.map((c) => {
    const type = classify(c.properties.hs_analytics_first_url, c.properties.hs_analytics_last_url);
    const { first, last } = deriveName(c);
    const e1 = copyFor(type, first);
    return {
      email: c.properties.email,
      first_name: first,
      last_name: last || undefined,
      company_name: c.properties.company || undefined,
      payload: { firstName: first, lastName: last || "", companyName: c.properties.company || "" },
      custom_variables: {
        e1_subject: e1.e1_subject,
        e1_body: e1.e1_body,
        e2_body: E2(first),
        e3_body: E3(first),
      },
    };
  });
  const result = await mcpInstantly("add_leads_to_campaign_or_list_bulk", { campaign_id: INBOUND_CAMPAIGN_ID, leads, skip_if_in_campaign: true });
  log(`instantly enroll: ${JSON.stringify(result).slice(0, 300)}`);

  for (const c of legit) state.enrolled[c.id] = classify(c.properties.hs_analytics_first_url, c.properties.hs_analytics_last_url);
  fs.writeFileSync(STATE, JSON.stringify(state));
  log(JSON.stringify({ ok: true, newEnrollments: legit.length, junkSkipped: skipped.length }));
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: e.message }, null, 2));
  fs.writeFileSync(STATE, JSON.stringify(state));
  process.exit(1);
}
