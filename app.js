/**
 * Local Timesheet App (localStorage + import/export/email + optional server sync)
 *
 * Server expectations:
 * - GET  {clients:[], sheets:[], entries:[], meta?:{...}}
 * - PUT/POST accepts the same JSON body and returns JSON (recommended)
 * - CORS must allow your origin if served from a different domain
 */

(() => {
  const STORAGE_KEY = "local_timesheet_v2";
  const DEFAULT_SYNC = {
    readUrl: "",
    writeUrl: "",
    method: "PUT",        // PUT or POST
    bearerToken: "",      // optional
    lastSyncAt: ""
  };

  // ---------- utils ----------
  const uid = () => (crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + "_" + Math.random().toString(16).slice(2));
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  function parseHHMM(s) {
    if (!s || !/^\d{2}:\d{2}$/.test(s)) return null;
    const [hh, mm] = s.split(":").map(Number);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return hh * 60 + mm;
  }

  function hoursBetween(timeIn, timeOut) {
    const a = parseHHMM(timeIn);
    const b = parseHHMM(timeOut);
    if (a == null || b == null) return null;
    let diff = b - a;
    if (diff < 0) diff += 24 * 60;
    return diff / 60;
  }

  function inRange(dateStr, startStr, endStr) {
    return dateStr >= startStr && dateStr <= endStr;
  }

  function fmtDate(d) {
    if (!d) return "";
    const [y,m,day] = d.split("-");
    return `${m}/${day}/${y}`;
  }

  function fmtHours(h) {
    if (h == null || Number.isNaN(h)) return "";
    return round2(h).toFixed(2);
  }
  function compareEntriesByDateTime(a, b) {
    // Sort ascending by workDate, then timeIn, then timeOut, then createdAt
    const d = (a.workDate || "").localeCompare(b.workDate || "");
    if (d !== 0) return d;

    const ti = (a.timeIn || "").localeCompare(b.timeIn || "");
    if (ti !== 0) return ti;

    const to = (a.timeOut || "").localeCompare(b.timeOut || "");
    if (to !== 0) return to;

    return (a.createdAt || "").localeCompare(b.createdAt || "");
  }
  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function downloadText(filename, text, mime="application/json") {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
    return blob;
  }

  // ---------- storage ----------
  function seedState() {
    const clientId = uid();
    const sheetId = uid();
    return {
      clients: [{ id: clientId, name: "First Baptist Church" }],
      sheets: [{
        id: sheetId,
        clientId,
        personName: "Name Here",
        periodStart: "2026-02-16",
        periodEnd: "2026-03-01"
      }],
      entries: [],
      settings: {
        sync: { ...DEFAULT_SYNC }
      }
    };
  }

  function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        // Backfill settings if older version
        parsed.settings ??= {};
        parsed.settings.sync ??= { ...DEFAULT_SYNC };
        return parsed;
      } catch {}
    }
    const seeded = seedState();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
    return seeded;
  }

  let state = loadState();

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  // ---------- data helpers ----------
  const byId = (arr, id) => arr.find(x => x.id === id) || null;
  const clientName = (clientId) => byId(state.clients, clientId)?.name ?? "(Unknown client)";

  function sheetTotals(sheet) {
    const entries = state.entries.filter(e => e.sheetId === sheet.id);
    const sum = entries.reduce((acc, e) => acc + (Number(e.totalHours) || 0), 0);
    return { count: entries.length, sumHours: round2(sum) };
  }

  function clientEntries(clientId) {
    return state.entries
      .filter(e => e.clientId === clientId)
      .slice()
      .sort(compareEntriesByDateTime);
  }
  function lastPersonNameFallback() {
    const sheets = state.sheets.slice().sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1));
    const last = sheets[0];
    return (last?.personName && last.personName.trim()) ? last.personName.trim() : "Name Here";
  }

  function currentSheetForClient(clientId) {
    const sheets = state.sheets.filter(s => s.clientId === clientId);
    sheets.sort((a,b) => (a.periodStart < b.periodStart ? 1 : -1));
    return sheets[0] || null;
  }

  // ---------- import/export/merge ----------
  function sanitizeImported(obj) {
    // Very lightweight validation + normalization
    if (!obj || typeof obj !== "object") throw new Error("JSON is not an object.");
    const out = {
      clients: Array.isArray(obj.clients) ? obj.clients : [],
      sheets: Array.isArray(obj.sheets) ? obj.sheets : [],
      entries: Array.isArray(obj.entries) ? obj.entries : [],
      settings: obj.settings && typeof obj.settings === "object" ? obj.settings : {}
    };
    out.settings.sync ??= { ...DEFAULT_SYNC };
    return out;
  }

  function mergeImported(current, incoming) {
    // Merge by id; if same id exists, incoming wins
    const mergeById = (a, b) => {
      const map = new Map(a.map(x => [x.id, x]));
      for (const item of b) map.set(item.id, item);
      return Array.from(map.values());
    };
    const merged = {
      clients: mergeById(current.clients, incoming.clients),
      sheets: mergeById(current.sheets, incoming.sheets),
      entries: mergeById(current.entries, incoming.entries),
      settings: { ...current.settings, ...incoming.settings }
    };
    merged.settings.sync ??= { ...DEFAULT_SYNC };
    return merged;
  }

  function exportPayload() {
    return {
      meta: {
        exportedAt: new Date().toISOString(),
        app: "local-timesheet",
        version: 2
      },
      clients: state.clients,
      sheets: state.sheets,
      entries: state.entries,
      settings: state.settings
    };
  }

  // ---------- server sync ----------
  async function syncLoadFromUrl() {
    const { readUrl, bearerToken } = state.settings.sync;
    if (!readUrl) throw new Error("Read URL is blank.");

    const headers = {};
    if (bearerToken) headers["Authorization"] = `Bearer ${bearerToken}`;

    const res = await fetch(readUrl, { method: "GET", headers });
    if (!res.ok) throw new Error(`GET failed: ${res.status} ${res.statusText}`);

    const json = await res.json();
    const incoming = sanitizeImported(json);
    return incoming;
  }

  async function syncSaveToUrl(payloadObj) {
    const { writeUrl, method, bearerToken } = state.settings.sync;
    if (!writeUrl) throw new Error("Write URL is blank.");

    const headers = { "Content-Type": "application/json" };
    if (bearerToken) headers["Authorization"] = `Bearer ${bearerToken}`;

    const res = await fetch(writeUrl, {
      method: (method === "POST" ? "POST" : "PUT"),
      headers,
      body: JSON.stringify(payloadObj)
    });

    if (!res.ok) throw new Error(`${method} failed: ${res.status} ${res.statusText}`);

    // Optional JSON response
    try { return await res.json(); } catch { return null; }
  }

  // ---------- router ----------
  const routes = {
    "#/sheets": renderSheets,
    "#/client": renderClientEntries,
    "#/entry/new": renderEntryFormNew,
    "#/entry/edit": renderEntryFormEdit,
    "#/settings": renderSettings,
    "#/print": renderPrintSheet
  };

  function getHash() {
    if (!location.hash) return "#/sheets";
    const [path] = location.hash.split("?");
    return routes[path] ? path : "#/sheets";
  }

  function getQuery() {
    const q = {};
    const parts = location.hash.split("?");
    if (parts.length < 2) return q;
    const sp = new URLSearchParams(parts.slice(1).join("?"));
    for (const [k,v] of sp.entries()) q[k] = v;
    return q;
  }

  function navTo(hash) { location.hash = hash; }

  // ---------- dom ----------
  const app = document.getElementById("app");
  const nav = document.getElementById("nav");

  function renderNav() {
    const items = [
      { href: "#/sheets", label: "Time Sheets" },
      ...(state.clients[0] ? [{ href: `#/client?clientId=${state.clients[0].id}`, label: "Client Entries" }] : []),
      { href: "#/settings", label: "Settings" }
    ];
    const current = getHash();
    nav.innerHTML = items.map(i => {
      const [path] = i.href.split("?");
      const active = (path === current) ? "active" : "";
      return `<a class="${active}" href="${i.href}">${escapeHtml(i.label)}</a>`;
    }).join("");
  }

  function render() {
    renderNav();
    routes[getHash()]();
  }

  // ---------- pages ----------
  function renderSheets() {
    const rows = state.sheets
      .slice()
      .sort((a,b) => (a.periodStart < b.periodStart ? 1 : -1))
      .map(sheet => {
        const totals = sheetTotals(sheet);
        const client = clientName(sheet.clientId);
        return `
          <tr>
            <td>
              <div><b>${escapeHtml(sheet.personName || "—")}</b></div>
              <div class="small muted">${escapeHtml(client)}</div>
            </td>
            <td>${fmtDate(sheet.periodStart)} → ${fmtDate(sheet.periodEnd)}</td>
            <td class="right">${totals.count}</td>
            <td class="right"><b>${fmtHours(totals.sumHours)}</b></td>
            <td class="right">
              <a href="#/client?clientId=${sheet.clientId}&sheetId=${sheet.id}">View entries</a>
              <span class="muted"> · </span>
              <a href="#/print?sheetId=${sheet.id}">Print</a>
            </td>
          </tr>
        `;
      }).join("");

    app.innerHTML = `
      <div class="grid">
        <section class="card">
          <h2>All Time Sheets</h2>
          <div class="kpi">
            <span class="pill">Clients: <b>${state.clients.length}</b></span>
            <span class="pill">Sheets: <b>${state.sheets.length}</b></span>
            <span class="pill">Entries: <b>${state.entries.length}</b></span>
          </div>
          <div class="hr"></div>

          ${state.sheets.length ? `
            <table>
              <thead>
                <tr>
                  <th>For</th>
                  <th>Period</th>
                  <th class="right">Entries</th>
                  <th class="right">Total Hours</th>
                  <th class="right">Link</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          ` : `<div class="empty">No timesheets yet. Add one in Settings.</div>`}
        </section>

        <aside class="card">
          <h2>Quick Add</h2>
          <p class="muted small">Pick a client and add a time entry for their current period.</p>
          <div class="row">
            <div>
              <label>Client</label>
              <select id="quickClient">
                ${state.clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="actions" style="margin-top:10px;">
            <button class="primary" id="quickGo">Add Time Entry</button>
            <button class="ghost" id="quickView">View Entries</button>
          </div>

          <div class="hr"></div>

          <h2>Backup / Sync</h2>
          <div class="actions">
            <button id="exportBtn">Export JSON</button>
            <button id="emailBtn">Email / Share</button>
            <a class="pill" href="#/settings" style="align-self:center;">Server URLs</a>
          </div>
          <p class="muted small" id="syncStatus"></p>
        </aside>
      </div>
    `;

    document.getElementById("quickGo")?.addEventListener("click", () => {
      const clientId = document.getElementById("quickClient").value;
      const sheet = currentSheetForClient(clientId);
      if (!sheet) return alert("No timesheet period for that client yet. Create one in Settings.");
      navTo(`#/entry/new?clientId=${clientId}&sheetId=${sheet.id}`);
    });

    document.getElementById("quickView")?.addEventListener("click", () => {
      const clientId = document.getElementById("quickClient").value;
      navTo(`#/client?clientId=${clientId}`);
    });

    document.getElementById("exportBtn")?.addEventListener("click", () => {
      const payload = exportPayload();
      const filename = `timesheet_export_${new Date().toISOString().slice(0,19).replaceAll(":","-")}.json`;
      downloadText(filename, JSON.stringify(payload, null, 2));
    });

    document.getElementById("emailBtn")?.addEventListener("click", async () => {
      const payload = exportPayload();
      const jsonText = JSON.stringify(payload, null, 2);

      // 1) Try Web Share API (best for attaching a file on mobile)
      try {
        if (navigator.share && navigator.canShare) {
          const file = new File([jsonText], "timesheet.json", { type: "application/json" });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({
              title: "Timesheet JSON Export",
              text: "Timesheet export attached.",
              files: [file]
            });
            return;
          }
        }
      } catch (e) {
        // fall through to mailto
      }

      // 2) Fallback: mailto with JSON in body
      // NOTE: mailto URLs have length limits; big datasets may fail.
      const subject = encodeURIComponent("Timesheet JSON Export");
      const body = encodeURIComponent(
        "Timesheet export JSON (copy into a .json file if needed):\n\n" + jsonText
      );
      const mailto = `mailto:?subject=${subject}&body=${body}`;
      window.location.href = mailto;
    });

    const ss = document.getElementById("syncStatus");
    const last = state.settings.sync.lastSyncAt;
    ss.textContent = last ? `Last server sync: ${new Date(last).toLocaleString()}` : "No server sync yet.";
  }

  function renderClientEntries() {
    const { clientId, sheetId } = getQuery();
    const client = byId(state.clients, clientId) || state.clients[0];
    if (!client) {
      app.innerHTML = `<div class="card"><h2>No clients</h2><div class="empty">Add a client in Settings.</div></div>`;
      return;
    }
    let sheet = sheetId ? byId(state.sheets, sheetId) : null;
    if(!sheet || sheet.clientId !== client.id) {
       sheet = currentSheetForClient(client.id);
    }
    const all = clientEntries(client.id)
      .slice()
      .sort(compareEntriesByDateTime);
    const totalsAll = all.reduce((acc, e) => acc + (Number(e.totalHours) || 0), 0);

    app.innerHTML = `
      <div class="card">
        <div class="row" style="align-items:flex-end;">
          <div style="flex:2">
            <h2 style="margin-bottom:6px;">Entries — ${escapeHtml(client.name)}</h2>
            <div class="kpi">
              <span class="pill">All entries: <b>${all.length}</b></span>
              <span class="pill">All hours: <b>${fmtHours(totalsAll)}</b></span>
              ${sheet ? `<span class="pill">Period: <b>${fmtDate(sheet.periodStart)} → ${fmtDate(sheet.periodEnd)}</b></span>` : `<span class="pill warn">No period set</span>`}
            </div>
          </div>
          <div style="flex:1">
            <label>Client</label>
            <select id="clientPick">
              ${state.clients.map(c => `<option value="${c.id}" ${c.id===client.id?"selected":""}>${escapeHtml(c.name)}</option>`).join("")}
            </select>
          </div>
          <div style="flex:1">
            <label>Search (date, notes)</label>
            <input id="search" placeholder="e.g. 2026-02-20 or rehearsal" />
          </div>
        </div>

        <div class="actions" style="margin-top:10px;">
          <button class="primary" id="addEntry" ${sheet ? "" : "disabled"}>+ Add Time Entry</button>
          <button id="exportClientBtn">Export JSON</button>
          <a href="#/sheets" class="pill" style="align-self:center;">Back to sheets</a>
        </div>

        <div class="hr"></div>

        <div id="results"></div>
      </div>
    `;

    document.getElementById("clientPick").addEventListener("change", (e) => {
      navTo(`#/client?clientId=${e.target.value}`);
    });

    document.getElementById("addEntry").addEventListener("click", () => {
      const s = sheet;
      if (!s) return alert("No timesheet period for this client yet. Create one in Settings.");
      console.log('sheet', s.id);
      navTo(`#/entry/new?clientId=${client.id}&sheetId=${s.id}`);
    });

    document.getElementById("exportClientBtn").addEventListener("click", () => {
      const payload = exportPayload();
      const filtered = {
        meta: payload.meta,
        clients: payload.clients.filter(c => c.id === client.id),
        sheets: payload.sheets.filter(s => s.clientId === client.id),
        entries: payload.entries
          .filter(en => en.clientId === client.id)
          .slice()
          .sort(compareEntriesByDateTime),
        settings: payload.settings
      };
      const filename = `timesheet_${client.name.replaceAll(" ","_")}_${new Date().toISOString().slice(0,10)}.json`;
      downloadText(filename, JSON.stringify(filtered, null, 2));
    });

    const results = document.getElementById("results");
    const search = document.getElementById("search");

    function renderResults() {
      const term = (search.value || "").trim().toLowerCase();
      const filtered = all.filter(e => {
        if (!term) return true;
        return (e.workDate || "").includes(term)
          || (e.notes || "").toLowerCase().includes(term)
          || (e.timeIn || "").includes(term)
          || (e.timeOut || "").includes(term);
      });

      const current = sheet
        ? filtered
          .filter(e => inRange(e.workDate, sheet.periodStart, sheet.periodEnd))
          .slice()
          .sort(compareEntriesByDateTime)
        : [];
      const totalCurrent = current.reduce((acc, e) => acc + (Number(e.totalHours) || 0), 0);

      const rows = filtered.map(e => `
        <tr>
          <td>${fmtDate(e.workDate)}</td>
          <td>${escapeHtml(e.timeIn || "")}</td>
          <td>${escapeHtml(e.timeOut || "")}</td>
          <td class="right">${fmtHours(e.breakHours || 0)}</td>
          <td class="right"><b>${fmtHours(e.totalHours)}</b></td>
          <td>${escapeHtml(e.notes || "")}</td>
          <td class="right"><a href="#/entry/edit?id=${e.id}">Edit</a></td>
        </tr>
      `).join("");

      results.innerHTML = `
        ${sheet ? `
          <div class="kpi" style="margin-bottom:10px;">
            <span class="pill">In current period: <b>${current.length}</b></span>
            <span class="pill">Current period hours: <b>${fmtHours(totalCurrent)}</b></span>
          </div>
        ` : ""}

        ${filtered.length ? `
          <table>
            <thead>
              <tr>
                <th>Date</th><th>In</th><th>Out</th>
                <th class="right">Break (hrs)</th>
                <th class="right">Total (hrs)</th>
                <th>Notes</th>
                <th class="right">Action</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        ` : `<div class="empty">No matching entries.</div>`}
      `;
    }

    search.addEventListener("input", renderResults);
    renderResults();
  }

  function renderEntryFormNew() {
    const { clientId, sheetId } = getQuery();
    const client = byId(state.clients, clientId);
    const sheet = byId(state.sheets, sheetId);
    if (!client || !sheet) {
      app.innerHTML = `<div class="card"><h2>Missing client or sheet</h2><div class="empty">Go back to <a href="#/sheets">Time Sheets</a>.</div></div>`;
      return;
    }
    renderEntryForm({ mode: "new", client, sheet, entry: null });
  }

  function renderEntryFormEdit() {
    const { id } = getQuery();
    const entry = byId(state.entries, id);
    if (!entry) {
      app.innerHTML = `<div class="card"><h2>Entry not found</h2><div class="empty">Go back to <a href="#/sheets">Time Sheets</a>.</div></div>`;
      return;
    }
    const client = byId(state.clients, entry.clientId);
    const sheet = byId(state.sheets, entry.sheetId);
    renderEntryForm({ mode: "edit", client, sheet, entry });
  }

  function renderEntryForm({ mode, client, sheet, entry }) {
    const title = mode === "new" ? "Add Time Entry" : "Edit Time Entry";
    const isEdit = mode === "edit";

    const workDate = entry?.workDate ?? sheet.periodStart;
    const timeIn = entry?.timeIn ?? "09:00";
    const timeOut = entry?.timeOut ?? "17:00";
    const breakHours = (entry?.breakHours ?? 0).toString();
    const notes = entry?.notes ?? "";

    app.innerHTML = `
      <div class="grid">
        <section class="card">
          <h2>${escapeHtml(title)}</h2>
          <div class="kpi">
            <span class="pill">Client: <b>${escapeHtml(client.name)}</b></span>
            <span class="pill">Period: <b>${fmtDate(sheet.periodStart)} → ${fmtDate(sheet.periodEnd)}</b></span>
            <span class="pill">Name: <b>${escapeHtml(sheet.personName || "—")}</b></span>
          </div>
          <div class="hr"></div>

          <form id="entryForm">
            <div class="row">
              <div>
                <label>Date</label>
                <input type="date" id="workDate" value="${escapeHtml(workDate)}" required />
                <div class="small muted">Must be within ${fmtDate(sheet.periodStart)} → ${fmtDate(sheet.periodEnd)}.</div>
              </div>
              <div>
                <label>Time In</label>
                <input type="time" id="timeIn" value="${escapeHtml(timeIn)}" required />
              </div>
              <div>
                <label>Time Out</label>
                <input type="time" id="timeOut" value="${escapeHtml(timeOut)}" required />
              </div>
            </div>

            <div class="row" style="margin-top:10px;">
              <div>
                <label>Breaks (hours)</label>
                <input type="number" id="breakHours" step="0.1" min="0" value="${escapeHtml(breakHours)}" />
                <div class="small muted">Use decimals like 0.5 for 30 minutes.</div>
              </div>
              <div>
                <label>Total Hours (auto)</label>
                <input type="text" id="totalHours" value="" readonly />
                <div class="small muted" id="calcHint"></div>
              </div>
            </div>

            <div style="margin-top:10px;">
              <label>Notes</label>
              <textarea id="notes" placeholder="Optional notes...">${escapeHtml(notes)}</textarea>
            </div>

            <div class="actions" style="margin-top:12px;">
              <button class="primary" type="submit">${isEdit ? "Save Changes" : "Add Entry"}</button>
              <button class="ghost" type="button" id="cancelBtn">Cancel</button>
              ${isEdit ? `<button class="danger" type="button" id="deleteBtn">Delete</button>` : ""}
            </div>
          </form>
        </section>

        <aside class="card">
          <h2>Summary</h2>
          <div id="summary"></div>
          <div class="hr"></div>
          <h2>Tips</h2>
          <ul class="small muted" style="margin:0; padding-left:18px;">
            <li>Total = (Time Out − Time In) − Breaks</li>
            <li>If Time Out is earlier than Time In, it’s treated as an overnight shift.</li>
          </ul>
        </aside>
      </div>
    `;

    const elWorkDate = document.getElementById("workDate");
    const elTimeIn = document.getElementById("timeIn");
    const elTimeOut = document.getElementById("timeOut");
    const elBreak = document.getElementById("breakHours");
    const elTotal = document.getElementById("totalHours");
    const elHint = document.getElementById("calcHint");
    const summary = document.getElementById("summary");

    function recalc() {
      const hrs = hoursBetween(elTimeIn.value, elTimeOut.value);
      const br = Number(elBreak.value || 0);
      if (hrs == null || Number.isNaN(br)) {
        elTotal.value = "";
        elHint.textContent = "Enter valid times and break hours.";
        return null;
      }
      const total = round2(Math.max(0, hrs - br));
      elTotal.value = fmtHours(total);

      const inPeriod = inRange(elWorkDate.value, sheet.periodStart, sheet.periodEnd);
      elHint.innerHTML = inPeriod
        ? `<span class="ok">Looks good.</span> Computed from ${escapeHtml(elTimeIn.value)} → ${escapeHtml(elTimeOut.value)} minus ${fmtHours(br)} break hours.`
        : `<span class="warn">Date outside period.</span> Must be within ${fmtDate(sheet.periodStart)} → ${fmtDate(sheet.periodEnd)}.`;
      return { total, br, hrs, inPeriod };
    }

    function renderSummary() {
      const totals = sheetTotals(sheet);
      summary.innerHTML = `
        <div class="kpi">
          <span class="pill">Entries in sheet: <b>${totals.count}</b></span>
          <span class="pill">Sheet hours: <b>${fmtHours(totals.sumHours)}</b></span>
        </div>
      `;
    }

    [elWorkDate, elTimeIn, elTimeOut, elBreak].forEach(el => el.addEventListener("input", recalc));
    recalc();
    renderSummary();
    const backSheetId = entry?.sheetId || sheet.id;
    document.getElementById("cancelBtn").addEventListener("click", () => navTo(`#/client?clientId=${client.id}&sheetId=${backSheetId}`));

    document.getElementById("entryForm").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const calc = recalc();
      if (!calc) return alert("Please fix the time fields.");
      if (!calc.inPeriod) return alert(`Date must be within ${fmtDate(sheet.periodStart)} to ${fmtDate(sheet.periodEnd)}.`);

      const now = new Date().toISOString();
      const payload = {
        clientId: client.id,
        sheetId: sheet.id,
        workDate: elWorkDate.value,
        timeIn: elTimeIn.value,
        timeOut: elTimeOut.value,
        breakHours: round2(Number(elBreak.value || 0)),
        totalHours: calc.total,
        notes: document.getElementById("notes").value || "",
        updatedAt: now
      };

      if (mode === "new") {
        state.entries.push({ id: uid(), createdAt: now, ...payload });
      } else {
        const idx = state.entries.findIndex(e => e.id === entry.id);
        if (idx >= 0) state.entries[idx] = { ...state.entries[idx], ...payload };
      }

      saveState();
      navTo(`#/client?clientId=${client.id}&sheetId=${backSheetId}`);
    });

    if (isEdit) {
      document.getElementById("deleteBtn").addEventListener("click", () => {
        if (!confirm("Delete this time entry?")) return;
        state.entries = state.entries
          .filter(e => e.id !== entry.id)
          .slice()
          .sort(compareEntriesByDateTime);
        saveState();
        navTo(`#/client?clientId=${client.id}&sheetId=${backSheetId}`);
      });
    }
  }

  function renderSettings() {
    const sync = state.settings.sync;

    app.innerHTML = `
      <div class="grid">
        <section class="card">
          <h2>Clients & Time Sheets</h2>

          <div class="row">
            <div style="flex:2">
              <label>Add client</label>
              <input id="newClientName" placeholder="Client name" />
            </div>
            <div style="flex:1">
              <label>&nbsp;</label>
              <button class="primary" id="addClientBtn">Add Client</button>
            </div>
          </div>

          <div class="hr"></div>

          <div class="row">
            <div>
              <label>Client</label>
              <select id="sheetClient">
                ${state.clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}
              </select>
            </div>
          </div>

          <div class="row" style="margin-top:10px;">
            <div>
              <label>Name (who the sheet is for)</label>
              <input id="sheetPerson" placeholder="e.g., Lewis Moten" value="${escapeHtml(lastPersonNameFallback())}" />
            </div>
          </div>

          <div class="row" style="margin-top:10px;">
            <div>
              <label>Period start</label>
              <input type="date" id="sheetStart" value="2026-02-16" />
            </div>
            <div>
              <label>Period end</label>
              <input type="date" id="sheetEnd" value="2026-03-01" />
            </div>
          </div>

          <div class="actions" style="margin-top:12px;">
            <button class="primary" id="addSheetBtn">Add Time Sheet</button>
            <button class="danger" id="resetBtn" type="button">Reset All Data</button>
          </div>
        </section>

        <aside class="card">
          <h2>Import / Export</h2>

          <div class="actions">
            <button id="exportBtn">Export JSON</button>
            <button id="shareBtn">Email / Share</button>
          </div>

          <div class="hr"></div>

          <label>Import JSON file</label>
          <input type="file" id="importFile" accept="application/json,.json" />

          <div class="row" style="margin-top:10px;">
            <div>
              <label>Import mode</label>
              <select id="importMode">
                <option value="merge">Merge (keep existing + add/overwrite by id)</option>
                <option value="replace">Replace (discard current data)</option>
              </select>
            </div>
            <div style="align-self:end;">
              <button class="primary" id="importBtn">Import</button>
            </div>
          </div>

          <div class="hr"></div>

          <h2>Server URL Sync</h2>
          <p class="muted small">
            This uses fetch(). Your server must support CORS and accept/return JSON.
          </p>

          <label>Read URL (GET)</label>
          <input id="readUrl" placeholder="https://example.com/timesheet.json" value="${escapeHtml(sync.readUrl)}" />

          <label style="margin-top:10px;">Write URL (PUT/POST)</label>
          <input id="writeUrl" placeholder="https://example.com/timesheet.json" value="${escapeHtml(sync.writeUrl)}" />

          <div class="row" style="margin-top:10px;">
            <div>
              <label>Write method</label>
              <select id="writeMethod">
                <option value="PUT" ${sync.method==="PUT"?"selected":""}>PUT</option>
                <option value="POST" ${sync.method==="POST"?"selected":""}>POST</option>
              </select>
            </div>
            <div>
              <label>Bearer token (optional)</label>
              <input id="bearerToken" placeholder="paste token" value="${escapeHtml(sync.bearerToken)}" />
            </div>
          </div>

          <div class="actions" style="margin-top:12px;">
            <button id="saveSyncBtn" class="primary">Save Sync Settings</button>
            <button id="loadFromUrlBtn">Load from Read URL</button>
            <button id="saveToUrlBtn">Save to Write URL</button>
          </div>

          <div class="hr"></div>
          <div class="small muted">Last sync: ${sync.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleString() : "Never"}</div>
          <div id="syncMsg" class="small muted" style="margin-top:8px;"></div>
        </aside>
      </div>

      <div class="card" style="margin-top:14px;">
        <h2>Existing Sheets</h2>
        ${state.sheets.length ? `
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Name</th>
                <th>Period</th>
                <th class="right">Entries</th>
                <th class="right">Total Hours</th>
                <th class="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${state.sheets
                .slice()
                .sort((a,b) => (a.periodStart < b.periodStart ? 1 : -1))
                .map(s => {
                  const t = sheetTotals(s);
                  return `
                    <tr>
                      <td>${escapeHtml(clientName(s.clientId))}</td>
                      <td><b>${escapeHtml(s.personName || "—")}</b></td>
                      <td>${fmtDate(s.periodStart)} → ${fmtDate(s.periodEnd)}</td>
                      <td class="right">${t.count}</td>
                      <td class="right"><b>${fmtHours(t.sumHours)}</b></td>
                      <td class="right">
                        <a href="#/client?clientId=${s.clientId}&sheetId=${s.id}">View entries</a>
                        <button class="danger" data-del-sheet="${s.id}" style="width:auto;">Delete</button>
                        <span class="muted"> · </span>
                        <a href="#/print?sheetId=${s.id}">Print</a>
                      </td>
                    </tr>
                  `;
                }).join("")}
            </tbody>
          </table>
        ` : `<div class="empty">No sheets yet.</div>`}
      </div>

      <div class="card" style="margin-top:14px;">
        <h2>Server JSON Shape (example)</h2>
        <div class="code">${
          escapeHtml(JSON.stringify({
            clients: [{ id:"...", name:"First Baptist Church" }],
            sheets: [{ id:"...", clientId:"...", personName:"Name Here", periodStart:"2026-02-16", periodEnd:"2026-03-01" }],
            entries: [{ id:"...", clientId:"...", sheetId:"...", workDate:"2026-02-16", timeIn:"09:00", timeOut:"17:00", breakHours:0.5, totalHours:7.5, notes:"...", createdAt:"...", updatedAt:"..." }],
            settings: { sync: { readUrl:"", writeUrl:"", method:"PUT", bearerToken:"", lastSyncAt:"" } }
          }, null, 2))
        }</div>
      </div>
    `;

    // Clients + sheets
    document.getElementById("addClientBtn").addEventListener("click", () => {
      const name = document.getElementById("newClientName").value.trim();
      if (!name) return alert("Enter a client name.");
      state.clients.push({ id: uid(), name });
      saveState();
      render();
    });

    document.getElementById("addSheetBtn").addEventListener("click", () => {
      if (!state.clients.length) return alert("Add a client first.");
      const clientId = document.getElementById("sheetClient").value;
      const personName = document.getElementById("sheetPerson").value.trim() || "Name Here";
      const periodStart = document.getElementById("sheetStart").value;
      const periodEnd = document.getElementById("sheetEnd").value;
      if (!periodStart || !periodEnd) return alert("Choose a start and end date.");
      if (periodEnd < periodStart) return alert("Period end must be on/after period start.");
      state.sheets.push({ id: uid(), clientId, personName, periodStart, periodEnd });
      saveState();
      render();
    });

    document.getElementById("resetBtn").addEventListener("click", () => {
      if (!confirm("Reset ALL local data for this app?")) return;
      localStorage.removeItem(STORAGE_KEY);
      state = loadState();
      render();
    });

    // Export + email/share
    document.getElementById("exportBtn").addEventListener("click", () => {
      const payload = exportPayload();
      const filename = `timesheet_export_${new Date().toISOString().slice(0,19).replaceAll(":","-")}.json`;
      downloadText(filename, JSON.stringify(payload, null, 2));
    });

    document.getElementById("shareBtn").addEventListener("click", async () => {
      const payload = exportPayload();
      const jsonText = JSON.stringify(payload, null, 2);

      try {
        if (navigator.share && navigator.canShare) {
          const file = new File([jsonText], "timesheet.json", { type: "application/json" });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ title: "Timesheet JSON Export", text: "Timesheet export attached.", files: [file] });
            return;
          }
        }
      } catch {}

      const subject = encodeURIComponent("Timesheet JSON Export");
      const body = encodeURIComponent("Timesheet export JSON:\n\n" + jsonText);
      window.location.href = `mailto:?subject=${subject}&body=${body}`;
    });

    // Import
    const importFile = document.getElementById("importFile");
    document.getElementById("importBtn").addEventListener("click", async () => {
      const mode = document.getElementById("importMode").value;
      const file = importFile.files?.[0];
      if (!file) return alert("Choose a JSON file first.");
      try {
        const text = await file.text();
        const incomingRaw = JSON.parse(text);
        const incoming = sanitizeImported(incomingRaw);

        if (mode === "replace") {
          state = incoming;
        } else {
          state = mergeImported(state, incoming);
        }
        saveState();
        alert(`Imported successfully (${mode}).`);
        render();
      } catch (e) {
        alert("Import failed: " + (e?.message || String(e)));
      }
    });

    // Server sync settings
    const msg = document.getElementById("syncMsg");
    const setMsg = (text, isError=false) => {
      msg.innerHTML = isError ? `<span class="warn">${escapeHtml(text)}</span>` : `<span class="ok">${escapeHtml(text)}</span>`;
    };

    document.getElementById("saveSyncBtn").addEventListener("click", () => {
      state.settings.sync.readUrl = document.getElementById("readUrl").value.trim();
      state.settings.sync.writeUrl = document.getElementById("writeUrl").value.trim();
      state.settings.sync.method = document.getElementById("writeMethod").value;
      state.settings.sync.bearerToken = document.getElementById("bearerToken").value.trim();
      saveState();
      setMsg("Saved sync settings.");
    });

    document.getElementById("loadFromUrlBtn").addEventListener("click", async () => {
      try {
        // Save current input values first
        document.getElementById("saveSyncBtn").click();

        const incoming = await syncLoadFromUrl();
        // Default: merge so you don't blow away local work
        state = mergeImported(state, incoming);
        state.settings.sync.lastSyncAt = new Date().toISOString();
        saveState();
        setMsg("Loaded from URL and merged into local data.");
        render();
      } catch (e) {
        setMsg("Load failed: " + (e?.message || String(e)), true);
      }
    });

    document.getElementById("saveToUrlBtn").addEventListener("click", async () => {
      try {
        document.getElementById("saveSyncBtn").click();
        const payload = exportPayload();
        await syncSaveToUrl(payload);
        state.settings.sync.lastSyncAt = new Date().toISOString();
        saveState();
        setMsg("Saved to URL successfully.");
        render();
      } catch (e) {
        setMsg("Save failed: " + (e?.message || String(e)), true);
      }
    });
    app.querySelectorAll("[data-del-sheet]").forEach(btn => {
  btn.addEventListener("click", () => {
    const sheetId = btn.getAttribute("data-del-sheet");
    const sheet = byId(state.sheets, sheetId);
    if (!sheet) return;

    const entryCount = state.entries.filter(e => e.sheetId === sheetId).length;

    const alsoDeleteEntries = confirm(
      `Delete this time sheet?\n\nClient: ${clientName(sheet.clientId)}\nPeriod: ${fmtDate(sheet.periodStart)} → ${fmtDate(sheet.periodEnd)}\n\nIt has ${entryCount} entries.\n\nOK = Delete sheet AND its entries\nCancel = choose another option`
    );

    if (!alsoDeleteEntries) {
      // Second confirm: delete sheet only (leaves entries orphaned unless you reassign)
      const sheetOnly = confirm(
        "Delete sheet ONLY (leave entries in storage)?\n\nWarning: those entries won’t appear in any sheet totals."
      );
      if (!sheetOnly) return;

      state.sheets = state.sheets.filter(s => s.id !== sheetId);
      saveState();
      render();
      return;
    }

    // Delete sheet + its entries
    state.sheets = state.sheets.filter(s => s.id !== sheetId);
    state.entries = state.entries
      .filter(e => e.sheetId !== sheetId)
      .slice()
      .sort(compareEntriesByDateTime);
    saveState();
    render();
  });
});
  }
function renderPrintSheet() {
  const { sheetId } = getQuery();
  const sheet = byId(state.sheets, sheetId) || null;

  if (!sheet) {
    app.innerHTML = `
      <div class="card">
        <h2>Print</h2>
        <div class="empty">Sheet not found. Go back to <a href="#/sheets">Time Sheets</a>.</div>
      </div>
    `;
    return;
  }

  const client = byId(state.clients, sheet.clientId);
  const entries = state.entries
    .filter(e => e.sheetId === sheet.id)
    .slice()
    .sort(compareEntriesByDateTime);

  const totalHours = entries.reduce((acc, e) => acc + (Number(e.totalHours) || 0), 0);

  const rows = entries.map(e => `
    <tr>
      <td>${fmtDate(e.workDate)}</td>
      <td>${escapeHtml(e.timeIn || "")}</td>
      <td>${escapeHtml(e.timeOut || "")}</td>
      <td class="right">${fmtHours(e.breakHours || 0)}</td>
      <td class="right"><b>${fmtHours(e.totalHours)}</b></td>
      <td>${escapeHtml(e.notes || "")}</td>
    </tr>
  `).join("");

  // Make the print view visually "paper-like" even on screen
  app.innerHTML = `
    <div class="print-page">
      <section class="card">
        <div class="print-header">
          <div>
            <h2>Time Sheet</h2>
            <div class="print-meta">
              <div><b>Client:</b> ${escapeHtml(client?.name || "(Unknown client)")}</div>
              <div><b>Name:</b> ${escapeHtml(sheet.personName || "—")}</div>
              <div><b>Period:</b> ${fmtDate(sheet.periodStart)} → ${fmtDate(sheet.periodEnd)}</div>
            </div>
          </div>

          <div class="no-print" style="display:flex; gap:10px; align-items:flex-start;">
            <button class="primary" id="printBtn" style="width:auto;">Print</button>
            <a class="pill" href="#/client?clientId=${sheet.clientId}&sheetId=${sheet.id}" style="align-self:center;">Back</a>
          </div>
        </div>

        <div class="hr"></div>

        <table>
          <thead>
            <tr>
              <th style="width:100px;">Date</th>
              <th style="width:70px;">In</th>
              <th style="width:70px;">Out</th>
              <th class="right" style="width:90px;">Break</th>
              <th class="right" style="width:90px;">Total</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="6" class="muted">No entries for this sheet.</td></tr>`}
          </tbody>
        </table>

        <div class="hr"></div>

        <div class="print-meta" style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap;">
          <div><b>Total Hours:</b> ${fmtHours(totalHours)}</div>
          <div><b>Printed:</b> ${new Date().toLocaleString()}</div>
        </div>

        <!-- Optional signature line
        <div style="margin-top:18px;">
          <div class="print-meta"><b>Signature:</b></div>
          <div style="border-bottom:1px solid #000; height:18px; margin-top:6px;"></div>
        </div>
        -->
      </section>
    </div>
  `;

  document.getElementById("printBtn")?.addEventListener("click", () => window.print());
}
  // ---------- boot ----------
  window.addEventListener("hashchange", render);
  if (!location.hash) location.hash = "#/sheets";
  render();
})();
