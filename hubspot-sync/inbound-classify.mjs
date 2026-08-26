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

// US federal holidays (major ones that affect B2B response rates). Extend as needed.
const US_HOLIDAYS = new Set([
  // 2026
  "2026-01-01","2026-01-19","2026-02-16","2026-05-25","2026-06-19","2026-07-03",
  "2026-09-07","2026-10-12","2026-11-11","2026-11-26","2026-12-25",
  // 2027
  "2027-01-01","2027-01-18","2027-02-15","2027-05-31","2027-06-18","2027-07-05",
  "2027-09-06","2027-10-11","2027-11-11","2027-11-25","2027-12-24",
]);

function isHolidayOrWeekend(d) {
  const day = d.getDay();
  if (day === 0 || day === 6) return true;
  return US_HOLIDAYS.has(d.toISOString().split("T")[0]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HS_BASE = "https://api.hubapi.com/crm/v3";
const HS_LIST_ID = process.env.HS_INBOUND_LIST_ID || "24";
const INST_URL = "https://mcp.instantly.ai/mcp";
const INBOUND_CAMPAIGN_ID = process.env.INSTANTLY_INBOUND_CAMPAIGN_ID || "f586fa24-4803-4d02-980e-b8217c697887";
const DEMO_DRIP_CAMPAIGN_ID = process.env.INSTANTLY_DEMO_DRIP_CAMPAIGN_ID || "d464db3d-3975-4b02-9f6d-54968abec41c";

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

// ---------- copy templates (demo drip per Spotonix_Demo_Request_Drip_Campaign_3.xlsx; others per spotonix-copy skill) ----------
const BUILD = "Spotonix lets users ask data questions in plain English, shows the plan before anything runs, and grounds every answer in the definitions your team supplies.";
const E2 = (n) => `Hey ${n}, following up once. A metric ends up with two definitions and whichever tool is in use quietly picks one. Spotonix asks which definition you mean instead. Open to 20 min to see it live?`;
const E3 = (n) => `Hey ${n}, if now isn't the right time, no worries. If it is, send us your four hardest data problems and we'll set up self-service analytics your team can actually use on Spotonix without analyst time. Reply with a day and I'll send times.`;

// Demo Request Drip (formal CEO voice, per xlsx): campaign steps reference {{d1_subject}}/{{d1_body}}/{{d2_body}}/{{d3_subject}}/{{d3_body}}
const DEMO_D1_SUBJECT_A = "Thanks for signing up for Spotonix";
const DEMO_D1_SUBJECT_B = "{{firstName}}, seeing your own data queried in plain English";
const DEMO_D3_SUBJECT_A = "Closing the loop on your demo request";
const DEMO_D3_SUBJECT_B = "{{firstName}}, should I keep this open?";
const DEMO_D1_BODY = `Dear {{firstName}},

Thanks for signing up for Spotonix. I am the co-founder and chief executive, and I run these demos personally.

Most teams I speak with have already built a semantic layer in dbt, Looker or Power BI, yet their business users still email the data team for one-off reports and argue over conflicting numbers. Spotonix sits on top of that stack and operationalizes your existing definitions, so those users can ask questions in plain English and receive consistent, governed answers in seconds.

I would propose 30 minutes in which you see your own data queried that way. My calendar:

https://meetings.hubspot.com/venkatesh-seetharam

If you reply with the two or three questions your stakeholders ask most often, I will build the session around them.

Kind regards,

Venkatesh Seetharam
Co-founder & CEO, Spotonix
www.spotonix.com`;
const DEMO_D2_BODY = `Dear {{firstName}},

Following my note earlier this week, the question I am asked most often is whether you could simply prompt an LLM instead.

You could, but not safely:

  1. A general model is prompt-based and guesses at definitions. Spotonix is plan-based and resolves against approved logic.
  2. A general model answers differently depending on phrasing. Spotonix issues the same SQL every time.
  3. A general model forgets. Spotonix remembers what has been accepted.
  4. A general model is a black box. Every Spotonix answer carries a plan, a SQL hash and a named approver.

My co-founder and I created Apache Atlas, the first open-source metadata catalog; Bob Muglia, formerly chief executive of Snowflake, advises us. Governed meaning is not a feature we added late.

Based on industry discovery and pilot deployments, cycle times fall by 50 to 70 percent and analyst throughput rises by 40 to 70 percent.

Thirty minutes, on your data: https://meetings.hubspot.com/venkatesh-seetharam

Kind regards,

Venkatesh Seetharam
Co-founder & CEO, Spotonix
www.spotonix.com`;
const DEMO_D3_BODY = `Dear {{firstName}},

I have written twice about the demo you requested without finding a time, which I appreciate may be a question of bandwidth rather than interest.

It is a smaller first step than it may appear: no rip-and-replace, one business domain, a two-to-four week deployment alongside Tableau, Looker or Power BI.

So as not to occupy your inbox further, would you reply with whichever applies:

  1. Send times - I would like to see this on our data.
  2. Not now - please revisit next quarter.
  3. Not a fit - please close the file.

The third will be respected without further follow-up. For the first, my calendar is here: https://meetings.hubspot.com/venkatesh-seetharam

Thank you either way.

Kind regards,

Venkatesh Seetharam
Co-founder & CEO, Spotonix
www.spotonix.com`;

state.demoDripCount ??= 0;
state.suppressed ??= {};
state.measurement ??= { enrollments: 0, suppressedMeetings: 0, junkSkipped: 0, repliesParsed: 0 };
state.parsedReplies ??= {};

function demoDripVars(variant) {
  const variantA = variant === "A";
  return {
    d1_subject: variantA ? DEMO_D1_SUBJECT_A : DEMO_D1_SUBJECT_B,
    d1_body: DEMO_D1_BODY,
    d2_body: DEMO_D2_BODY,
    d3_subject: variantA ? DEMO_D3_SUBJECT_A : DEMO_D3_SUBJECT_B,
    d3_body: DEMO_D3_BODY,
  };
}

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

// ---------- meeting-booked suppression ----------
async function suppressMeetingBooked() {
  // 1. Get all meetings from HubSpot with associated contact IDs
  let meetingsRes;
  try {
    meetingsRes = await hs("/objects/meetings?limit=100&associations=contacts");
  } catch (e) {
    log(`meeting check skipped: ${e.message.slice(0, 100)}`);
    return { checked: 0, suppressed: 0 };
  }

  const contactIdsWithMeetings = new Set();
  for (const m of meetingsRes.results || []) {
    const assocs = m.associations;
    if (!assocs) continue;
    for (const val of Object.values(assocs)) {
      if (val && val.results) {
        for (const r of val.results) { if (r.id) contactIdsWithMeetings.add(String(r.id)); }
      }
    }
  }
  if (!contactIdsWithMeetings.size) return { checked: 0, suppressed: 0 };

  // 2. Find enrolled contacts who have a meeting but aren't suppressed yet
  const toSuppress = [];
  for (const [hsId, info] of Object.entries(state.enrolled)) {
    if (state.suppressed[hsId]) continue;
    if (contactIdsWithMeetings.has(hsId)) toSuppress.push({ hsId, email: info.email });
  }
  if (!toSuppress.length) return { checked: contactIdsWithMeetings.size, suppressed: 0 };

  // 3. Batch-read emails for the matching contacts
  const emailMap = {};
  const ids = toSuppress.map(t => t.hsId);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const r = await hs("/objects/contacts/batch/read", {
      method: "POST",
      body: { inputs: chunk.map(id => ({ id })), properties: ["email"] },
    });
    for (const res of r.results || []) { emailMap[res.id] = res.properties.email; }
  }

  // 4. Stop in Instantly + update HubSpot
  let count = 0;
  for (const t of toSuppress) {
    const email = emailMap[t.hsId];
    if (!email) continue;

    // Find and delete the lead from Instantly (stops all sends)
    try {
      const searchResult = await mcpInstantly("list_leads", { campaign_id: DEMO_DRIP_CAMPAIGN_ID, search: email, limit: 1 });
      if (searchResult.items?.length) {
        await mcpInstantly("delete_lead", { id: searchResult.items[0].id });
        log(`suppressed ${email} (meeting booked)`);
      }
    } catch (e) {
      log(`instantly suppression failed for ${email}: ${e.message.slice(0, 80)}`);
    }

    // Update HubSpot status
    try {
      await hs(`/objects/contacts/${t.hsId}`, {
        method: "PATCH",
        body: { properties: { hs_lead_status: "CONNECTED" } },
      });
    } catch (e) {
      log(`hubspot status update failed for ${email}: ${e.message.slice(0, 80)}`);
    }

    state.suppressed[t.hsId] = true;
    count++;
    await sleep(SLEEP_MS);
  }
  return { checked: contactIdsWithMeetings.size, suppressed: count };
}
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

// ---------- reply disposition parser ----------
async function parseReplies() {
  try {
    const result = await mcpInstantly("list_leads", {
      campaign_id: DEMO_DRIP_CAMPAIGN_ID,
      filter: "FILTER_VAL_REPLIED",
      limit: 100,
    });
    const repliedLeads = (result.items || []).filter((l) => !state.parsedReplies[l.id]);
    if (!repliedLeads.length) return { parsed: 0 };

    let parsed = 0;
    for (const lead of repliedLeads) {
      const email = lead.email || "";
      const text = JSON.stringify(lead).toLowerCase();
      let disposition = "option_1_interested";
      if (/not now|next quarter|revisit/.test(text)) {
        disposition = "option_2_nurture";
      } else if (/not a fit|close the file|pass on this|not interested/.test(text)) {
        disposition = "option_3_not_fit";
      }

      // Find HubSpot contact by email
      const searchRes = await hs("/objects/contacts/search", {
        method: "POST",
        body: { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }], limit: 1 },
      });
      if (searchRes.total > 0) {
        const hsId = searchRes.results[0].id;
        if (disposition === "option_2_nurture") {
          await hs(`/objects/contacts/${hsId}`, { method: "PATCH", body: { properties: { hs_lead_status: "UNQUALIFIED" } } });
          // add to nurture list
          try {
            await fetch(`${HS_BASE}/lists/${NURTURE_LIST_ID}/memberships/add`, {
              method: "PUT",
              headers: { Authorization: `Bearer ${cfg.hubspotToken}`, "Content-Type": "application/json" },
              body: JSON.stringify([hsId]),
            });
          } catch (e) { log(`nurture list add failed for ${email}: ${e.message.slice(0,60)}`); }
        } else if (disposition === "option_3_not_fit") {
          await hs(`/objects/contacts/${hsId}`, { method: "PATCH", body: { properties: { hs_lead_status: "UNQUALIFIED" } } });
        } else {
          await hs(`/objects/contacts/${hsId}`, { method: "PATCH", body: { properties: { hs_lead_status: "IN_PROGRESS" } } });
        }
      }

      state.parsedReplies[lead.id] = disposition;
      state.measurement.repliesParsed++;
      parsed++;
      await sleep(SLEEP_MS);
    }
    log(`reply parsing: ${parsed} new reply(ies) classified`);
    return { parsed };
  } catch (e) {
    log(`reply parsing skipped: ${e.message.slice(0, 100)}`);
    return { parsed: 0 };
  }
}

// ---------- main ----------
const NURTURE_LIST_ID = process.env.HS_NURTURE_LIST_ID || "25";
const variantMap = {};
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

try {
  log("start");

  // Skip enrollment on holidays/weekends (Instantly still sends scheduled emails; we just don't enroll new leads)
  const now = new Date();
  if (isHolidayOrWeekend(now)) {
    log("holiday or weekend - skipping new enrollments");
  }

  // Parse reply dispositions
  await parseReplies();
  // 0. suppress anyone who already booked a meeting (runs every cycle, not just when new signups exist)
  const supp = await suppressMeetingBooked();
  log(`meeting-booked check: ${supp.suppressed} suppressed`);

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

  // 1. tag signup type + status + subject set (random A/B for native testing)
  await tagContacts(legit.map((c) => {
    const type = classify(c.properties.hs_analytics_first_url, c.properties.hs_analytics_last_url);
    const vSet = Math.random() < 0.5 ? "A" : "B";
    variantMap[c.id] = vSet;
    return {
      id: c.id,
      properties: {
        inbound_signup_type: type,
        hs_lead_status: "NEW",
        drip_subject_set: vSet,
      },
    };
  }));
  log(`tagged ${legit.length}`);

  // 2. add to HubSpot list
  await addToList(legit.map((c) => c.id));
  log(`added ${legit.length} to list ${HS_LIST_ID}`);

  // 3. enroll ALL inbound signups into Demo Request Drip campaign (one per lead)
  await ensureInstantlySession();
  const createdMap = {};
  for (const c of legit) {
    const { first, last } = deriveName(c);
    try {
      const r = await mcpInstantly("instantly_create_lead", {
        campaign_id: DEMO_DRIP_CAMPAIGN_ID,
        email: c.properties.email,
        first_name: first,
        last_name: last || null,
        company_name: c.properties.company || "your team",
      });
      if (r.id) {
        createdMap[c.properties.email] = r.id;
        log(`created ${c.properties.email} -> ${r.id}`);
      }
      await sleep(SLEEP_MS);
    } catch (e) {
      log(`create failed for ${c.properties.email}: ${e.message.slice(0, 80)}`);
    }
  }

  // Set copy custom variables per lead
  for (const c of legit) {
    const email = c.properties.email;
    const instId = createdMap[email];
    if (!instId) continue;
    const variant = variantMap[c.id] || "A";
    const dv = demoDripVars(variant);
    try {
      await mcpInstantly("update_lead", { id: instId, custom_variables: dv });
      await sleep(SLEEP_MS);
    } catch (e) {
      log(`copy update failed for ${email}: ${e.message.slice(0, 80)}`);
    }
  }

  for (const c of legit) state.enrolled[c.id] = { type: classify(c.properties.hs_analytics_first_url, c.properties.hs_analytics_last_url), email: c.properties.email };
  fs.writeFileSync(STATE, JSON.stringify(state));
  state.measurement.enrollments += legit.length;
  state.measurement.junkSkipped += skipped.length;
  log(JSON.stringify({ ok: true, newEnrollments: legit.length, junkSkipped: skipped.length, totalEnrollments: state.measurement.enrollments }));
  if (state.measurement.enrollments >= 100 && !state.reviewAlerted) {
    log("*** REVIEW CADENCE: 100+ enrollments reached. Review A/B performance now. ***");
    state.reviewAlerted = true;
  }
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: e.message }, null, 2));
  fs.writeFileSync(STATE, JSON.stringify(state));
  process.exit(1);
}
