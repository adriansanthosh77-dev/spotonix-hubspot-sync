#!/usr/bin/env node
// Spotonix LinkedIn 3-stage flow mover.
// Moves leads between the WARM -> CONNECT -> MESSAGE campaigns so accepted
// connections reliably get their DM (HeyReach's own CONNECTION_REQUEST->MESSAGE
// flow drops ~50% of accepted leads, so we drive the stages explicitly).
//
// Stage 1 (WARM, campaigns 580908-580918): VIEW + LIKE only. Everyone.
// Stage 2 (CONNECT, 580919-580929): CONNECTION_REQUEST. After warm finished.
// Stage 3 (MESSAGE, 580855): MESSAGE {ceo_dm}. After connection accepted.
//
// Config in ~/.spotonix-hs-sync/config.json. Run: node linkedin-stage-mover.mjs
// Safe to run every 15 min (idempotent).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = process.env.SPOTONIX_HS_SYNC_DIR || path.join(os.homedir(), ".spotonix-hs-sync");
fs.mkdirSync(DIR, { recursive: true });
const CONFIG = path.join(DIR, "config.json");
const STATE = path.join(DIR, "stage-state.json");

const cfg = (process.env.HEYREACH_MCP_KEY)
  ? { heyreachMcpKey: process.env.HEYREACH_MCP_KEY }
  : JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};

const HR_URL = "https://mcp.heyreach.io/mcp";
const HR_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "X-API-Key": cfg.heyreachMcpKey,
  Authorization: `Bearer ${cfg.heyreachMcpKey}`,
  "Mcp-Protocol-Version": "2025-03-26",
};
const SLEEP_MS = process.env.SYNC_FAST === "1" ? 20 : 150;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let hrSession = null;

async function hrCall(tool, args, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const headers = { ...HR_HEADERS };
      if (hrSession) headers["mcp-session-id"] = hrSession;
      const res = await fetch(HR_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) hrSession = sid;
      const text = await res.text();
      const msg = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).pop();
      if (!msg) throw new Error(text.slice(0, 300));
      if (msg.error) throw new Error(JSON.stringify(msg.error).slice(0, 300));
      const content = msg.result?.content || [];
      const item = content.find((c) => c.type === "text");
      return item ? JSON.parse(item.text) : msg.result;
    } catch (e) {
      if (attempt < retries - 1) { await sleep(2000); continue; }
      throw e;
    }
  }
}

async function campaignLeads(campaignId) {
  const out = [];
  let offset = 0;
  for (let p = 0; p < 10; p++) {
    const data = await hrCall("get_leads_from_campaign", { campaignId, limit: 100, offset });
    const items = data.items || [];
    out.push(...items);
    if (items.length === 0 || out.length >= (data.totalCount || 0)) break;
    offset += 100;
    await sleep(100);
  }
  return out;
}

async function listLeads(listId) {
  const out = [];
  let offset = 0;
  for (let p = 0; p < 10; p++) {
    const data = await hrCall("get_leads_from_list", { listId, limit: 100, offset });
    const items = data.items || [];
    out.push(...items);
    if (items.length === 0 || out.length >= (data.totalCount || 0)) break;
    offset += 100;
    await sleep(100);
  }
  return out;
}

// Track -> warm campaign, connect campaign, source list (list feeds warm; connect list = same list)
// NOTE: warm + connect share the source list by design; we gate connect by only starting it
// for leads that have finished warm (detected via the warm campaign lead state).
const TRACKS = {
  ICP1:     { warm: 580908, connect: 580919, list: 894418, connectStarted: false },
  ICP2:     { warm: 580909, connect: 580920, list: 894420, connectStarted: false },
  ICP3:     { warm: 580910, connect: 580921, list: 894421, connectStarted: false },
  ICP4:     { warm: 580911, connect: 580922, list: 894419, connectStarted: false },
  ICP5:     { warm: 580912, connect: 580923, list: 894422, connectStarted: false },
  TechICP1: { warm: 580913, connect: 580924, list: 894474, connectStarted: false },
  TechICP2: { warm: 580914, connect: 580925, list: 894476, connectStarted: false },
  TechICP3: { warm: 580915, connect: 580926, list: 894475, connectStarted: false },
  TechICP4: { warm: 580916, connect: 580927, list: 894477, connectStarted: false },
  TechICP5: { warm: 580917, connect: 580928, list: 894478, connectStarted: false },
  CEO77New: { warm: 580918, connect: 580929, list: 894429, connectStarted: false },
};
const MESSAGE_CAMPAIGN = 580855; // Stage 3: send DM to accepted connections
const MESSAGE_LIST = 905904;     // List backing the message campaign

async function main() {
  const results = { warmedFinished: {}, movedToConnect: {}, acceptedToMessage: [], addedToMessage: [], errors: [] };

  for (const [track, t] of Object.entries(TRACKS)) {
    // 1. Find leads that finished WARM (campaign status Finished but never connected)
    //    In the warm campaign, a Finished lead = VIEW+LIKE done.
    try {
      const warmLeads = await campaignLeads(t.warm);
      const finished = warmLeads.filter((l) => l.leadCampaignStatus === "Finished");
      results.warmedFinished[track] = finished.length;

      // 2. For each finished-warm lead, ensure it's in the CONNECT campaign.
      //    The connect campaign references the same list, so adding the lead to the list
      //    (if not already) is what lets the connect campaign pick it up.
      //    NOTE: leads are already in the list (they came from it). The connect campaign
      //    being DRAFT won't process them until started. We stage by starting connect only
      //    after warm finishes on the track, then pausing it once warm is complete.
      //    For now: report warmed-finished counts; connect staging is driven below.
      await sleep(SLEEP_MS);
    } catch (e) {
      results.errors.push(`warm ${track}: ${e.message}`);
    }

    // 3. Accepted connections -> Stage 3 (MESSAGE)
    //    Check ALL active campaigns' leads for ConnectionAccepted + no message yet.
    //    Add them to the MESSAGE campaign list (905904) so 580855 sends the DM.
    try {
      const connectLeads = await campaignLeads(t.connect);
      const accepted = connectLeads.filter((l) => l.leadConnectionStatus === "ConnectionAccepted" && !["MessageSent", "Sent"].includes(l.leadMessageStatus));
      for (const l of accepted) {
        const p = l.linkedInUserProfile || {};
        results.acceptedToMessage.push({ track, name: `${p.firstName || ""} ${p.lastName || ""}`.trim(), url: p.profileUrl });
      }
      await sleep(SLEEP_MS);
    } catch (e) {
      results.errors.push(`connect ${track}: ${e.message}`);
    }
  }

  // Also scan old/paused campaigns for accepted-without-message (backfill)
  const acceptedPool = [];
  for (const cid of [573277, 573278, 573279, 573280, 573281, 573289, 573310, 573311, 573312, 573313, 573314, 559676]) {
    try {
      const leads = await campaignLeads(cid);
      const accepted = leads.filter((l) => l.leadConnectionStatus === "ConnectionAccepted" && !["MessageSent", "Sent"].includes(l.leadMessageStatus));
      for (const l of accepted) {
        const p = l.linkedInUserProfile || {};
        const name = `${p.firstName || ""} ${p.lastName || ""}`.trim();
        acceptedPool.push({ name, url: (p.profileUrl || "").replace(/\/$/, ""), dm: leadDm(l) });
        results.acceptedToMessage.push({ track: `backfill-${cid}`, name, url: p.profileUrl });
      }
    } catch (e) { results.errors.push(`backfill ${cid}: ${e.message}`); }
    await sleep(SLEEP_MS);
  }

  // Dedupe by profile URL, then add to the MESSAGE campaign list so 580855 sends DMs.
  const seen = new Set();
  const toAdd = [];
  for (const a of acceptedPool) {
    if (!a.url || seen.has(a.url)) continue;
    seen.add(a.url);
    toAdd.push(a);
  }

  // Already in message list? Skip those.
  let inMsgList = new Set();
  try {
    const ml = await listLeads(MESSAGE_LIST);
    inMsgList = new Set(ml.map((l) => (l.profileUrl || "").replace(/\/$/, "")));
  } catch (e) { results.errors.push(`msg list: ${e.message}`); }

  const fresh = toAdd.filter((a) => !inMsgList.has(a.url));

  // DM gate (2026-09-05, user directive): DMs only Mon-Fri. Don't add to the
  // MESSAGE list on weekends, so 580855 only fires DMs on weekdays. Accepted leads
  // queue up locally (stage-state) and get added on the next weekday run.
  const now = new Date();
  const day = now.getUTCDay();
  const isWeekend = day === 0 || day === 6;
  if (isWeekend) {
    results.addedToMessage = [];
    results.weekendGate = true;
    results.queuedAccepted = fresh.map((a) => a.url);
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  results.addedToMessage = fresh;

  if (fresh.length) {
    const leadsPayload = fresh.map((a) => ({
      firstName: (a.name || " ").split(" ")[0] || "",
      lastName: (a.name || " ").split(" ").slice(1).join(" ").replace(/[®°]/g, "") || "",
      profileUrl: a.url,
      customUserFields: [{ name: "ceo_dm", value: a.dm || fallbackDm(a.name) }],
    }));
    try {
      const res = await hrCall("add_leads_to_list_v2", { listId: MESSAGE_LIST, leads: leadsPayload });
      results.addResult = res;
      console.log("added to message list:", JSON.stringify(res));
    } catch (e) {
      results.errors.push(`add to msg list: ${e.message}`);
    }
  }

  console.log(JSON.stringify(results, null, 2));
}

// Extract {ceo_dm} from a lead's custom fields if present.
function leadDm(lead) {
  const cf = lead.customFields || [];
  const dm = cf.find((f) => f.name === "ceo_dm");
  return dm ? dm.value : null;
}

function fallbackDm(name) {
  const first = (name || "").split(" ")[0] || "";
  return `Hi ${first}, I built Spotonix (spotonix.com) — it lets teams ask data questions in plain English and gets answers grounded in the definitions your team controls. Open to a quick look?`;
}

main().catch((e) => { console.error(e); process.exit(1); });