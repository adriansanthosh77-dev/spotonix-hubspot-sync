#!/usr/bin/env node
// Spotonix -> HubSpot full sync.
// Pulls ALL data from HeyReach (LinkedIn) and Instantly (email) via their MCP JSON-RPC
// endpoints (same transport opencode uses), upserts HubSpot contacts, and writes every
// message/reply as a timeline note. Idempotent via a state file.
//
// Config + state live in ~/.spotonix-hs-sync/ (OUTSIDE the repo, contains secrets).
// Run: node sync-to-hubspot.mjs   (safe to run every 15 min)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Config + state directory. Local default: ~/.spotonix-hs-sync
// Cloud (GitHub Actions): SPOTONIX_HS_SYNC_DIR points at a cached dir; config comes from env.
const DIR = process.env.SPOTONIX_HS_SYNC_DIR || path.join(os.homedir(), ".spotonix-hs-sync");
const CONFIG = path.join(DIR, "config.json");
const STATE = path.join(DIR, "state.json");

const cfg = (process.env.HUBSPOT_TOKEN && process.env.HEYREACH_MCP_KEY && process.env.INSTANTLY_KEY)
  ? {
      hubspotToken: process.env.HUBSPOT_TOKEN,
      heyreachMcpKey: process.env.HEYREACH_MCP_KEY,
      instantlyKey: process.env.INSTANTLY_KEY,
    }
  : JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};

// Cloud mode shortens safety sleeps so the whole sync finishes well under the 15-min cron.
const SLEEP_MS = process.env.SYNC_FAST === "1" ? 20 : 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// overlap guard: a run takes ~30 min but the task fires every 15 — skip if one is already running
if (state.lastRunStart && Date.now() - state.lastRunStart < 25 * 60 * 1000) {
  console.log(JSON.stringify({ ok: true, skipped: "previous run still active or too recent", lastRunStart: state.lastRunStart }));
  process.exit(0);
}
state.lastRunStart = Date.now();
state.hrNotesSeen ??= {};
state.instEmailsSeen ??= {};

const HS_BASE = "https://api.hubapi.com/crm/v3";
const HS = cfg.hubspotToken;
const HR_URL = "https://mcp.heyreach.io/mcp";
const HR_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "X-API-Key": cfg.heyreachMcpKey,
  Authorization: `Bearer ${cfg.heyreachMcpKey}`,
  "Mcp-Protocol-Version": "2025-03-26",
};
const INST_URL = "https://mcp.instantly.ai/mcp";

let hrSession = null;
let instSession = null;
let hrContacts = 0, instContacts = 0, hrNotes = 0, instNotes = 0, propsCreated = 0;

// ---------- generic MCP JSON-RPC over SSE ----------
async function mcpCall(baseHeaders, url, tool, args, getSession, setSession) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } });
  const headers = { ...baseHeaders };
  if (getSession?.()) headers["mcp-session-id"] = getSession();
  let res, text;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(600 * attempt);
    res = await fetch(url, { method: "POST", headers, body });
    const sid = res.headers.get("mcp-session-id");
    if (sid && setSession) setSession(sid);
    text = await res.text();
    // HTML/empty bodies = transient gateway error (Instantly returns 503 pages under load).
    // Careful: valid SSE payloads contain email HTML inside the JSON, so only match top-level HTML.
    const topLevel = text.trim().startsWith("<");
    if (topLevel || text.trim() === "") {
      if (attempt === 3) throw new Error(`${tool}: gateway error ${res.status}: ${text.slice(0, 80)}`);
      continue;
    }
    if (res.status !== 200 && !text.includes('"jsonrpc"')) {
      if (attempt === 3) throw new Error(`${tool}: HTTP ${res.status}: ${text.slice(0, 80)}`);
      continue;
    }
    break;
  }
  // SSE: each message is a line starting with "data:"
  const msgs = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((l) => l.length > 0)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  const last = msgs[msgs.length - 1];
  if (!last) throw new Error(`${tool}: no response (${text.slice(0, 300)})`);
  if (last.error) throw new Error(`${tool}: ${JSON.stringify(last.error)}`);
  const content = last.result?.content || [];
  const item = content.find((c) => c.type === "text");
  if (!item) return last.result;
  try {
    return JSON.parse(item.text);
  } catch (e) {
    throw new Error(`${tool}: item.text not JSON: ${item.text.slice(0, 300)}`);
  }
}

async function mcpHR(tool, args) {
  return mcpCall(HR_HEADERS, HR_URL, tool, args, () => hrSession, (v) => (hrSession = v));
}

async function mcpInstantly(tool, args) {
  if (!instSession) {
    const initRes = await fetch(INST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${cfg.instantlyKey}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "hs-sync", version: "1.0" } } }),
    });
    instSession = initRes.headers.get("mcp-session-id");
    if (!instSession) throw new Error("Instantly: initialize did not return a session id");
  }
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${cfg.instantlyKey}`,
    "mcp-session-id": instSession,
  };
  return mcpCall(headers, INST_URL, tool, args, () => instSession, (v) => (instSession = v));
}

// ---------- HubSpot helpers ----------
async function hs(path_, opts = {}) {
  const method = opts.method || "GET";
  const body = opts.body ? JSON.stringify(opts.body) : null;
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await sleep(400 * attempt);
    try {
      const res = await fetch(`${HS_BASE}${path_}`, {
        method,
        headers: { Authorization: `Bearer ${HS}`, "Content-Type": "application/json" },
        body,
      });
      const text = await res.text();
      if (res.status === 429) { lastErr = new Error("HS 429 rate limited"); continue; }
      if (!res.ok) throw new Error(`HS ${method} ${path_}: ${res.status} ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    } catch (e) {
      lastErr = e;
      if (e.message?.includes("HS ") && !e.message?.includes("fetch failed")) throw e; // non-transient HS error
    }
  }
  throw lastErr;
}

async function ensureContactProps() {
  const defs = [
    { name: "hr_campaign", label: "HR Campaign", type: "string", fieldType: "text" },
    { name: "hr_status", label: "HR Status", type: "string", fieldType: "text" },
    { name: "hr_connection_state", label: "HR Connection State", type: "string", fieldType: "text" },
    { name: "inst_campaign", label: "Instantly Campaign", type: "string", fieldType: "text" },
    { name: "inst_status", label: "Instantly Status", type: "string", fieldType: "text" },
    { name: "inst_interest_status", label: "Instantly Interest", type: "string", fieldType: "text" },
  ];
  const existing = new Set((await hs("/properties/contacts?limit=200")).results.map((p) => p.name));
  for (const d of defs) {
    if (existing.has(d.name)) continue;
    await hs("/properties/contacts", { method: "POST", body: { ...d, groupName: "contactinformation" } });
    propsCreated++;
    await sleep(SLEEP_MS);
  }
}

async function findContact({ email, linkedinUrl }) {
  if (email) {
    const r = await hs("/objects/contacts/search", {
      method: "POST",
      body: { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }], limit: 1, properties: ["email"] },
    });
    if (r.total > 0) return r.results[0].id;
  }
  if (linkedinUrl) {
    const r = await hs("/objects/contacts/search", {
      method: "POST",
      body: { filterGroups: [{ filters: [{ propertyName: "hs_linkedin_url", operator: "EQ", value: linkedinUrl }] }], limit: 1, properties: ["hs_linkedin_url"] },
    });
    if (r.total > 0) return r.results[0].id;
  }
  return null;
}

async function upsertContact({ email, linkedinUrl, props }) {
  const id = await findContact({ email, linkedinUrl });
  const clean = Object.fromEntries(Object.entries(props).filter(([, v]) => v != null && v !== ""));
  if (id) {
    if (Object.keys(clean).length) await hs(`/objects/contacts/${id}`, { method: "PATCH", body: { properties: clean } });
    return id;
  }
  if (!email && !linkedinUrl) return null; // no key, can't create
  const body = { properties: { ...clean, ...(email ? { email } : {}), ...(linkedinUrl ? { hs_linkedin_url: linkedinUrl } : {}) } };
  const created = await hs("/objects/contacts", { method: "POST", body });
  return created.id;
}

async function addNote(contactId, bodyText, tsMs) {
  const body = {
    properties: { hs_note_body: bodyText, ...(tsMs ? { hs_timestamp: String(tsMs) } : {}) },
  };
  const note = await hs("/objects/notes", { method: "POST", body });
  // association type note_to_contact = 202
  await hs(`/objects/notes/${note.id}/associations/contact/${contactId}/202`, { method: "PUT" });
}

// ---------- HeyReach ----------
async function pullHeyReach() {
  const campaigns = await mcpHR("get_all_campaigns", { limit: 100, offset: 0 });
  const list = campaigns.items || campaigns || [];
  const convs = [];
  let off = 0;
  for (;;) {
    const page = await mcpHR("get_conversations_v2", { limit: 100, offset: off });
    const items = page.items || [];
    convs.push(...items);
    if (items.length < 100) break;
    off += 100;
  }

  for (const c of list) {
    try {
      let lo = 0;
      for (;;) {
        const page = await mcpHR("get_leads_from_campaign", { campaignId: c.id, limit: 100, offset: lo });
        const leads = page.items || [];
        for (const lead of leads) {
          // NOTE: HeyReach nests the profile under linkedInUserProfile
          const p = lead.linkedInUserProfile || {};
          const email = p.emailAddress || p.enrichedEmailAddress || null;
          const url = p.profileUrl || null;
          const props = {
            firstname: p.firstName,
            lastname: p.lastName,
            jobtitle: p.position,
            company: p.companyName,
            hr_campaign: c.name,
            hr_status: lead.leadCampaignStatus || c.status,
          };
          const id = await upsertContact({ email, linkedinUrl: url, props });
          if (id) hrContacts++;
          await sleep(SLEEP_MS);
        }
        if (leads.length < 100) break;
        lo += 100;
      }
    } catch (e) {
      console.error(`[HeyReach] campaign ${c.name} skipped: ${e.message}`);
    }
  }

  for (const conv of convs) {
    const cp = conv.correspondentProfile || {};
    const url = cp.profileUrl || null;
    const email = cp.emailAddress || cp.enrichedEmailAddress || null;
    const props = {
      firstname: cp.firstName,
      lastname: cp.lastName,
      jobtitle: cp.position || cp.headline,
      company: cp.companyName,
    };
    const id = await upsertContact({ email, linkedinUrl: url, props });
    if (!id) continue;
    hrContacts++;
    for (const m of conv.messages || []) {
      const key = `${conv.id}:${m.createdAt}:${m.body?.slice(0, 40)}`;
      if (state.hrNotesSeen[key]) continue;
      const who = m.sender === "ME" ? "me" : cp.firstName || "lead";
      await addNote(id, `[HeyReach] ${who} (${m.createdAt}): ${m.body}`, Date.parse(m.createdAt) || Date.now());
      state.hrNotesSeen[key] = true;
      hrNotes++;
      await sleep(SLEEP_MS);
    }
  }
}

// ---------- Instantly ----------
async function pullInstantly() {
  const page1 = await mcpInstantly("list_campaigns", { limit: 100 });
  const campaigns = page1.items || [];
  const emails = [];
  try {
    let cursor = null;
    for (;;) {
      const args = { limit: 100, email_type: "received" };
      if (cursor) args.starting_after = cursor;
      const page = await mcpInstantly("list_emails", args);
      const items = page.items || [];
      emails.push(...items);
      if (!page.next_starting_after || items.length === 0) break;
      cursor = page.next_starting_after;
    }
  } catch (e) {
    console.error(`[Instantly] reply-email fetch partial: ${e.message}`);
  }

  for (const c of campaigns) {
    try {
      let cur = null;
      for (;;) {
        const args = { campaign: c.id, limit: 100, distinct_contacts: true };
        if (cur) args.starting_after = cur;
        const page = await mcpInstantly("list_leads", args);
        const leads = page.items || [];
        for (const lead of leads) {
          const email = lead.email || null;
          const props = {
            firstname: lead.first_name,
            lastname: lead.last_name,
            company: lead.company_name,
            inst_campaign: c.name,
            inst_status: lead.status ? String(lead.status) : null,
            inst_interest_status: lead.interest_status ? String(lead.interest_status) : null,
          };
          const id = await upsertContact({ email, linkedinUrl: null, props });
          if (id) instContacts++;
          await sleep(SLEEP_MS);
        }
        if (leads.length === 0) break;
        cur = leads[leads.length - 1].email; // distinct_contacts=true => starting_after is the last email
      }
    } catch (e) {
      console.error(`[Instantly] campaign ${c.name} skipped: ${e.message}`);
    }
  }

  try {
    for (const e of emails) {
      const sender = e.from_email || e.sender || null;
      const id = sender ? await upsertContact({ email: sender, linkedinUrl: null, props: { inst_status: "replied" } }) : null;
      if (!id) continue;
      instContacts++;
      const key = e.id || `${e.timestamp}:${e.subject}`;
      if (state.instEmailsSeen[key]) continue;
      const body = (e.body_preview || e.body_text || e.body_html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 500);
      await addNote(id, `[Instantly] reply ${e.timestamp ?? ""}${e.subject ? ` | ${e.subject}` : ""}: ${body || e.from_email}`);
      state.instEmailsSeen[key] = true;
      instNotes++;
      await sleep(SLEEP_MS);
    }
  } catch (e) {
    console.error(`[Instantly] email notes partial failure: ${e.message}`);
  }
}

// ---------- main ----------
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const progress = (label) => {
  log(`${label} -> hr contacts=${hrContacts} hr notes=${hrNotes} inst contacts=${instContacts} inst notes=${instNotes}`);
};
const progTimer = setInterval(() => progress("progress"), 20000);

try {
  log("start");
  await ensureContactProps();
  progress("props done");
  await pullHeyReach();
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  progress("heyreach done");
  await pullInstantly();
  state.lastRunStart = null;
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  progress("instantly done");
  clearInterval(progTimer);
  log(
    JSON.stringify({ ok: true, propsCreated, hrContacts, hrNotes, instContacts, instNotes,
      hrSeen: Object.keys(state.hrNotesSeen).length, instSeen: Object.keys(state.instEmailsSeen).length }, null, 2)
  );
} catch (e) {
  clearInterval(progTimer);
  console.error(JSON.stringify({ ok: false, error: e.message, stack: e.stack?.split("\n").slice(0, 4) }, null, 2));
  state.lastRunStart = null;
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  process.exit(1);
}
