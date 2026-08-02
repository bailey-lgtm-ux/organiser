/* =========================================================================
 * VCE Organiser — app logic
 * Plain JS, no dependencies. State persisted in localStorage, and — once
 * firebase-config.js is filled in — mirrored to the cloud by sync.js so the
 * same account sees the same organiser on every device.
 *
 * Sync notes: every item and subject carries an `updatedAt` stamp, and
 * deletions leave a `deleted: true` tombstone rather than vanishing. That
 * lets mergeStates() combine two devices item by item, so a phone that has
 * been offline for a week can't overwrite newer work done on the laptop.
 * ========================================================================= */

"use strict";

/* ---------- Constants ---------- */
const STORAGE_KEY = "vce-organiser-v1";
const TYPE_META = {
  homework: { label: "Homework", icon: "📝" },
  test:     { label: "Test",     icon: "🧪" },
  event:    { label: "Event",    icon: "📅" },
};
const DEFAULT_SUBJECTS = [
  { name: "English",       color: "#ef4444" },
  { name: "Maths Methods", color: "#3b82f6" },
  { name: "Biology",       color: "#22c55e" },
  { name: "Chemistry",     color: "#a855f7" },
  { name: "History",       color: "#f59e0b" },
  { name: "General",       color: "#64748b" },
];

/* Colours handed to subjects that quick-add invents (e.g. "Physics", "Politics"). */
const SUBJECT_PALETTE = [
  "#ef4444", "#3b82f6", "#22c55e", "#a855f7", "#f59e0b",
  "#14b8a6", "#ec4899", "#6366f1", "#84cc16", "#f97316",
];

/* ---------- State ---------- */
let state = { subjects: [], items: [], notified: {} };
let viewYear, viewMonth;            // currently displayed calendar month
let modalContext = { dayDate: null }; // remembers which day the "add" came from

/* ---------- Small helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* Mark a record as changed now — this is what merging compares across devices. */
function stamp(obj) {
  obj.updatedAt = Date.now();
  return obj;
}
/** Records still in play (i.e. not deleted on some other device). */
const activeItems = () => state.items.filter((i) => !i.deleted);
const activeSubjects = () => state.subjects.filter((s) => !s.deleted);
/** Soft-delete, so the deletion itself can travel to your other devices. */
function tombstone(rec) {
  rec.deleted = true;
  return stamp(rec);
}

/** Format a Date as a local YYYY-MM-DD string (no timezone drift). */
function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
/** Parse a YYYY-MM-DD string to a local Date at midnight. */
function fromDateStr(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
/** Combine a date string + time string into a local Date. */
function toDateTime(dateStr, timeStr) {
  const d = fromDateStr(dateStr);
  if (timeStr) {
    const [h, min] = timeStr.split(":").map(Number);
    d.setHours(h, min, 0, 0);
  }
  return d;
}
const todayStr = () => toDateStr(new Date());

function fmtTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, "0")}${ampm}`;
}

/* ---------- Persistence ---------- */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.subjects = parsed.subjects || [];
      state.items = parsed.items || [];
      state.notified = parsed.notified || {};
    }
  } catch (err) {
    console.error("Failed to load state:", err);
  }
  normalizeStamps(state);
  pruneOldRecords(state);
  if (!activeSubjects().length) {
    state.subjects = state.subjects.concat(
      DEFAULT_SUBJECTS.map((s) => ({ id: uid(), updatedAt: 0, ...s }))
    );
    saveState();
  }
}

/* Items saved before sync existed have no updatedAt. Derive one that both
   devices will compute identically, so a merge doesn't pick a winner at random. */
function normalizeStamps(s) {
  for (const it of s.items || []) {
    if (typeof it.updatedAt !== "number") it.updatedAt = it.createdAt || 0;
  }
  for (const sub of s.subjects || []) {
    if (typeof sub.updatedAt !== "number") sub.updatedAt = 0;
  }
}

/* Tombstones only need to live long enough to reach your other devices.
   Anything deleted over 90 days ago is dropped for good. The same cutoff
   clears out stale reminder keys, which otherwise accumulate forever and
   would eventually bloat the synced document. */
const TOMBSTONE_TTL_MS = 90 * 24 * 3600 * 1000;
function pruneOldRecords(s) {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  s.items = (s.items || []).filter((i) => !(i.deleted && (i.updatedAt || 0) < cutoff));
  s.subjects = (s.subjects || []).filter((x) => !(x.deleted && (x.updatedAt || 0) < cutoff));

  const oldestDate = toDateStr(new Date(cutoff));
  for (const key of Object.keys(s.notified || {})) {
    // Keys look like "<itemId>@YYYY-MM-DD"; drop ones long past.
    const date = key.slice(key.lastIndexOf("@") + 1);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date < oldestDate) delete s.notified[key];
  }
}

/**
 * Save locally and (if signed in) queue an upload.
 * @param {{push?: boolean}} opts pass push:false when the change *came from*
 *        the cloud and doesn't need sending straight back.
 */
function saveState(opts = {}) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error("Failed to save state:", err);
    toast("Couldn't save — storage may be full.");
  }
  if (opts.push !== false && window.OrgSync) window.OrgSync.pushSoon();
}

function subjectById(id) {
  // Deleted subjects are still looked up, so old items keep their colour.
  return state.subjects.find((s) => s.id === id) || { name: "—", color: "#64748b" };
}

/* =========================================================================
 * Merging two devices
 * ========================================================================= */
/**
 * Combine the local state with one that arrived from the cloud. Every record
 * is resolved on its own: whichever side stamped it most recently wins, and a
 * tombstone is just another version of that record. Nothing is ever dropped
 * merely because the other device hadn't heard of it.
 *
 * @returns {{items:Array, subjects:Array, notified:Object,
 *            localNewer:boolean, remoteNewer:boolean}}
 */
function mergeStates(local, remote) {
  const out = { localNewer: false, remoteNewer: false };

  for (const field of ["items", "subjects"]) {
    const byId = new Map();
    for (const rec of local[field] || []) byId.set(rec.id, rec);

    for (const theirs of remote[field] || []) {
      if (!theirs || !theirs.id) continue;
      const mine = byId.get(theirs.id);
      if (!mine) {
        byId.set(theirs.id, theirs);       // only they have it
        out.remoteNewer = true;
      } else if ((theirs.updatedAt || 0) > (mine.updatedAt || 0)) {
        byId.set(theirs.id, theirs);       // their version is fresher
        out.remoteNewer = true;
      } else if ((mine.updatedAt || 0) > (theirs.updatedAt || 0)) {
        out.localNewer = true;             // ours is fresher — they need it
      }
    }
    // Anything we hold that never appeared in their copy still needs uploading.
    const theirIds = new Set((remote[field] || []).map((r) => r && r.id));
    for (const id of byId.keys()) if (!theirIds.has(id)) out.localNewer = true;

    out[field] = Array.from(byId.values());
  }

  // "Already notified" is a one-way set: once fired anywhere, don't fire again.
  const notified = Object.assign({}, remote.notified || {});
  for (const key of Object.keys(local.notified || {})) {
    if (!notified[key]) out.localNewer = true;
    notified[key] = true;
  }
  for (const key of Object.keys(remote.notified || {})) {
    if (!(local.notified || {})[key]) out.remoteNewer = true;
  }
  out.notified = notified;

  return out;
}

/**
 * Fold subjects that share a name into one.
 *
 * Two devices that each invented their own "Biology" would otherwise both
 * survive a merge and show up twice. The survivor is the one with the
 * lowest id, which every device computes identically, so they all agree
 * without needing to coordinate.
 *
 * @returns {number} how many duplicates were folded away
 */
function dedupeSubjectsByName(s) {
  const winners = new Map();
  for (const sub of s.subjects) {
    if (sub.deleted) continue;
    const key = String(sub.name || "").trim().toLowerCase();
    if (!key) continue;
    const cur = winners.get(key);
    if (!cur || sub.id < cur.id) winners.set(key, sub);
  }

  const remap = new Map();
  for (const sub of s.subjects) {
    if (sub.deleted) continue;
    const win = winners.get(String(sub.name || "").trim().toLowerCase());
    if (win && win.id !== sub.id) remap.set(sub.id, win.id);
  }
  if (!remap.size) return 0;

  for (const it of s.items) {
    const target = remap.get(it.subjectId);
    if (target) { it.subjectId = target; stamp(it); }
  }
  for (const sub of s.subjects) {
    if (remap.has(sub.id)) tombstone(sub);
  }
  return remap.size;
}

/**
 * Called by sync.js whenever the cloud copy changes.
 * @returns {boolean} true if we still hold changes the cloud needs.
 */
function applyRemoteState(remote) {
  if (!remote || typeof remote !== "object") return true;
  normalizeStamps(remote);

  const merged = mergeStates(state, remote);
  state.items = merged.items;
  state.subjects = merged.subjects;
  state.notified = merged.notified;

  // Two devices meeting for the first time often both hold "English" etc.
  const folded = dedupeSubjectsByName(state);
  if (folded) merged.localNewer = true;

  if (merged.remoteNewer || folded) {
    saveState({ push: false });
    renderAll();
    // Refresh the subjects editor if it's open, but never yank the dropdown
    // out from under someone who is part-way through filling in the form.
    if (!$("#subjects-modal").hidden) renderSubjectManager();
    if ($("#item-modal").hidden) populateSubjectDropdown();
  }
  return merged.localNewer;
}

/* ---------- Recurrence ---------- */
/**
 * Return concrete occurrences of an item that fall within [rangeStart, rangeEnd]
 * (inclusive), as { item, date: "YYYY-MM-DD", key }.
 */
function expandOccurrences(item, rangeStart, rangeEnd) {
  const out = [];
  const start = fromDateStr(item.date);
  const rec = item.recurrence || { freq: "none", until: null };
  const hardEnd = rec.until ? fromDateStr(rec.until) : rangeEnd;
  const stopAt = hardEnd < rangeEnd ? hardEnd : rangeEnd;

  if (rec.freq === "none" || !rec.freq) {
    if (start >= rangeStart && start <= rangeEnd) pushOcc(out, item, start);
    return out;
  }

  // Walk forward from the item's start date to the visible range end.
  let cursor = new Date(start);
  let guard = 0;
  while (cursor <= stopAt && guard++ < 1000) {
    if (cursor >= rangeStart) pushOcc(out, item, cursor);
    cursor = advance(cursor, rec.freq);
  }
  return out;
}
function advance(date, freq) {
  const d = new Date(date);
  if (freq === "daily") d.setDate(d.getDate() + 1);
  else if (freq === "weekly") d.setDate(d.getDate() + 7);
  else if (freq === "monthly") d.setMonth(d.getMonth() + 1);
  return d;
}
function pushOcc(arr, item, dateObj) {
  const dateStr = toDateStr(dateObj);
  arr.push({ item, date: dateStr, key: `${item.id}@${dateStr}` });
}

/** All occurrences across all items within a range, sorted by datetime. */
function occurrencesInRange(rangeStart, rangeEnd) {
  const all = [];
  for (const item of activeItems()) {
    all.push(...expandOccurrences(item, rangeStart, rangeEnd));
  }
  all.sort((a, b) => {
    const da = toDateTime(a.date, a.item.time);
    const db = toDateTime(b.date, b.item.time);
    return da - db;
  });
  return all;
}

/* Completion is tracked per occurrence so recurring items can be ticked per day. */
function isDone(occ) {
  return !!(occ.item.completedDates && occ.item.completedDates.includes(occ.date));
}
function toggleDone(occ) {
  const item = occ.item;
  item.completedDates = item.completedDates || [];
  const i = item.completedDates.indexOf(occ.date);
  if (i >= 0) item.completedDates.splice(i, 1);
  else item.completedDates.push(occ.date);
  stamp(item);
  saveState();
  renderAll();
}

/* =========================================================================
 * Rendering
 * ========================================================================= */
function renderAll() {
  renderCalendar(viewYear, viewMonth);
  renderDashboard();
  renderLegend();
}

/* ---------- Calendar ---------- */
function renderCalendar(year, month) {
  const grid = $("#calendar-grid");
  const title = $("#cal-heading");
  const monthName = new Date(year, month, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
  title.textContent = monthName;

  // Grid spans full weeks: from the Sunday on/before the 1st to the Saturday on/after the last day.
  const first = new Date(year, month, 1);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay());
  const last = new Date(year, month + 1, 0);
  const gridEnd = new Date(last);
  gridEnd.setDate(last.getDate() + (6 - last.getDay()));

  const occByDay = {};
  for (const occ of occurrencesInRange(gridStart, gridEnd)) {
    (occByDay[occ.date] ||= []).push(occ);
  }

  const today = todayStr();
  grid.innerHTML = "";
  const cursor = new Date(gridStart);
  while (cursor <= gridEnd) {
    const dateStr = toDateStr(cursor);
    const cell = document.createElement("div");
    cell.className = "day-cell";
    cell.setAttribute("role", "gridcell");
    if (cursor.getMonth() !== month) cell.classList.add("other-month");
    if (dateStr === today) cell.classList.add("today");
    cell.dataset.date = dateStr;

    const num = document.createElement("div");
    num.className = "day-num";
    num.textContent = cursor.getDate();
    cell.appendChild(num);

    const dayOccs = occByDay[dateStr] || [];
    const shown = dayOccs.slice(0, 4);
    for (const occ of shown) {
      cell.appendChild(makeChip(occ));
    }
    if (dayOccs.length > shown.length) {
      const more = document.createElement("div");
      more.className = "chip-more";
      more.textContent = `+${dayOccs.length - shown.length} more`;
      cell.appendChild(more);
    }

    cell.addEventListener("click", () => openDayModal(dateStr));
    grid.appendChild(cell);
    cursor.setDate(cursor.getDate() + 1);
  }
}

function makeChip(occ) {
  const subj = subjectById(occ.item.subjectId);
  const chip = document.createElement("div");
  chip.className = "chip" + (isDone(occ) ? " done" : "");
  chip.style.background = subj.color;
  chip.title = `${TYPE_META[occ.item.type].label}: ${occ.item.title}` + (occ.item.time ? ` @ ${fmtTime(occ.item.time)}` : "");
  const icon = document.createElement("span");
  icon.className = "chip-icon";
  icon.textContent = TYPE_META[occ.item.type].icon;
  const label = document.createElement("span");
  label.textContent = (occ.item.time ? fmtTime(occ.item.time) + " " : "") + occ.item.title;
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  chip.appendChild(icon);
  chip.appendChild(label);
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    openItemModal(occ.item);
  });
  return chip;
}

function renderLegend() {
  const legend = $("#cal-legend");
  legend.innerHTML = "";
  for (const s of activeSubjects()) {
    const el = document.createElement("span");
    el.className = "legend-item";
    el.innerHTML = `<span class="dot" style="background:${s.color}"></span>${s.name}`;
    legend.appendChild(el);
  }
}

/* ---------- Dashboard (due soon) ---------- */
function renderDashboard() {
  const body = $("#dashboard-body");
  body.innerHTML = "";

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - 30); // catch recent overdue items
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  end.setDate(end.getDate() + 7);      // next 7 days

  const today = todayStr();
  const weekEnd = toDateStr(end);

  const overdue = [], todayItems = [], week = [];
  for (const occ of occurrencesInRange(start, end)) {
    if (isDone(occ)) continue;
    if (occ.date < today) overdue.push(occ);
    else if (occ.date === today) todayItems.push(occ);
    else week.push(occ);
  }

  addGroup(body, "Overdue", overdue, "overdue");
  addGroup(body, "Today", todayItems, "");
  addGroup(body, "Next 7 days", week, "");

  if (!overdue.length && !todayItems.length && !week.length) {
    const p = document.createElement("p");
    p.className = "empty-note";
    p.textContent = "🎉 Nothing due soon. You're all caught up!";
    body.appendChild(p);
  }
}

function addGroup(container, title, occs, cls) {
  if (!occs.length) return;
  const group = document.createElement("div");
  group.className = "dash-group " + cls;

  const head = document.createElement("div");
  head.className = "dash-group-title";
  head.innerHTML = `${title} <span class="count">${occs.length}</span>`;
  group.appendChild(head);

  for (const occ of occs) {
    group.appendChild(makeDashItem(occ));
  }
  container.appendChild(group);
}

function makeDashItem(occ) {
  const subj = subjectById(occ.item.subjectId);
  const row = document.createElement("div");
  row.className = "dash-item" + (isDone(occ) ? " done" : "");

  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = subj.color;

  const main = document.createElement("div");
  main.className = "dash-main";
  const title = document.createElement("div");
  title.className = "dash-title";
  title.textContent = occ.item.title;
  const meta = document.createElement("div");
  meta.className = "dash-meta";
  const when = dashWhen(occ);
  meta.innerHTML =
    `<span class="type-pill">${TYPE_META[occ.item.type].icon} ${TYPE_META[occ.item.type].label}</span>` +
    `<span>${subj.name}</span>` +
    `<span>${when}</span>`;
  main.appendChild(title);
  main.appendChild(meta);

  const check = document.createElement("button");
  check.type = "button";
  check.className = "check" + (isDone(occ) ? " checked" : "");
  check.textContent = "✓";
  check.setAttribute("aria-label", "Mark done");
  check.addEventListener("click", (e) => { e.stopPropagation(); toggleDone(occ); });

  row.appendChild(check);
  row.appendChild(dot);
  row.appendChild(main);
  row.addEventListener("click", () => openItemModal(occ.item));
  return row;
}

function dashWhen(occ) {
  const today = todayStr();
  const timePart = occ.item.time ? " · " + fmtTime(occ.item.time) : "";
  if (occ.date === today) return "Today" + timePart;
  const diff = Math.round((fromDateStr(occ.date) - fromDateStr(today)) / 86400000);
  if (diff === 1) return "Tomorrow" + timePart;
  if (diff === -1) return "Yesterday" + timePart;
  if (diff < 0) return `${Math.abs(diff)} days ago` + timePart;
  const label = fromDateStr(occ.date).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return label + timePart;
}

/* =========================================================================
 * Item modal (add / edit)
 * ========================================================================= */
function populateSubjectDropdown() {
  const sel = $("#item-subject");
  sel.innerHTML = "";
  for (const s of activeSubjects()) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name;
    sel.appendChild(opt);
  }
}

function openItemModal(item) {
  populateSubjectDropdown();
  const isEdit = !!item;
  $("#item-modal-title").textContent = isEdit ? "Edit item" : "Add item";
  $("#item-delete").hidden = !isEdit;

  if (isEdit) {
    $("#item-id").value = item.id;
    setRadio("item-type", item.type);
    $("#item-title").value = item.title;
    $("#item-subject").value = item.subjectId;
    $("#item-date").value = item.date;
    $("#item-time").value = item.time || "";
    $("#item-reminder").value = String(item.reminderMinutesBefore);
    $("#item-notes").value = item.notes || "";
    const rec = item.recurrence || { freq: "none", until: null };
    $("#item-recurrence").value = rec.freq || "none";
    $("#item-recurrence-until").value = rec.until || "";
  } else {
    $("#item-id").value = "";
    setRadio("item-type", "homework");
    $("#item-form").reset();
    setRadio("item-type", "homework");
    $("#item-subject").value = activeSubjects()[0]?.id || "";
    $("#item-date").value = modalContext.dayDate || todayStr();
    $("#item-time").value = "09:00";
    $("#item-reminder").value = "60";
    $("#item-recurrence").value = "none";
  }
  updateRecurrenceUntilVisibility();
  openModal("item-modal");
  setTimeout(() => $("#item-title").focus(), 40);
}

function setRadio(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}
function getRadio(name) {
  const el = document.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : null;
}

function updateRecurrenceUntilVisibility() {
  const freq = $("#item-recurrence").value;
  $("#recurrence-until-field").hidden = freq === "none";
}

function saveItemFromForm(e) {
  e.preventDefault();
  const id = $("#item-id").value;
  const freq = $("#item-recurrence").value;
  const data = {
    type: getRadio("item-type"),
    title: $("#item-title").value.trim(),
    subjectId: $("#item-subject").value,
    date: $("#item-date").value,
    time: $("#item-time").value,
    reminderMinutesBefore: Number($("#item-reminder").value),
    notes: $("#item-notes").value.trim(),
    recurrence: { freq, until: freq === "none" ? null : ($("#item-recurrence-until").value || null) },
  };
  if (!data.title || !data.date) { toast("Add a title and date."); return; }

  if (id) {
    const item = state.items.find((i) => i.id === id);
    if (item) stamp(Object.assign(item, data));
  } else {
    state.items.push(stamp({ id: uid(), createdAt: Date.now(), completedDates: [], ...data }));
  }
  saveState();
  closeModal("item-modal");
  renderAll();
  toast(id ? "Saved" : "Added");
}

function deleteCurrentItem() {
  const id = $("#item-id").value;
  if (!id) return;
  const item = state.items.find((i) => i.id === id);
  if (item) tombstone(item);
  saveState();
  closeModal("item-modal");
  renderAll();
  toast("Deleted");
}

/* =========================================================================
 * Day modal
 * ========================================================================= */
function openDayModal(dateStr) {
  modalContext.dayDate = dateStr;
  const d = fromDateStr(dateStr);
  $("#day-modal-title").textContent = d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

  const list = $("#day-items");
  list.innerHTML = "";
  const dayOccs = occurrencesInRange(d, d);
  for (const occ of dayOccs) {
    list.appendChild(makeDashItem(occ));
  }
  openModal("day-modal");
}

/* =========================================================================
 * Subjects modal
 * ========================================================================= */
function renderSubjectManager() {
  const list = $("#subject-list");
  list.innerHTML = "";
  for (const s of activeSubjects()) {
    const li = document.createElement("li");
    li.className = "subject-row";

    const color = document.createElement("input");
    color.type = "color";
    color.value = s.color;
    color.addEventListener("input", () => { s.color = color.value; stamp(s); saveState(); renderAll(); });

    const name = document.createElement("input");
    name.type = "text";
    name.value = s.name;
    name.addEventListener("change", () => { s.name = name.value.trim() || s.name; stamp(s); saveState(); renderAll(); });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn";
    del.textContent = "🗑";
    del.title = "Delete subject";
    del.addEventListener("click", () => {
      if (activeSubjects().length <= 1) { toast("Keep at least one subject."); return; }
      tombstone(s);
      // Reassign orphaned items to the first remaining subject.
      const fallback = activeSubjects()[0].id;
      state.items.forEach((it) => {
        if (it.subjectId === s.id) { it.subjectId = fallback; stamp(it); }
      });
      saveState();
      renderSubjectManager();
      renderAll();
    });

    li.append(color, name, del);
    list.appendChild(li);
  }
}

function addSubjectFromForm(e) {
  e.preventDefault();
  const name = $("#new-subject-name").value.trim();
  const color = $("#new-subject-color").value;
  if (!name) return;
  state.subjects.push(stamp({ id: uid(), name, color }));
  saveState();
  $("#new-subject-name").value = "";
  renderSubjectManager();
  renderAll();
}

/* =========================================================================
 * Notifications / reminders
 * ========================================================================= */
function updateReminderButton() {
  const btn = $("#enable-reminders");
  if (!("Notification" in window)) {
    btn.disabled = true;
    btn.querySelector(".btn-label").textContent = "No notifications";
    return;
  }
  if (Notification.permission === "granted") {
    btn.classList.add("on");
    btn.querySelector(".btn-label").textContent = "Reminders on";
  } else if (Notification.permission === "denied") {
    btn.querySelector(".btn-label").textContent = "Reminders blocked";
  } else {
    btn.querySelector(".btn-label").textContent = "Enable reminders";
  }
}

async function requestNotifications() {
  if (!("Notification" in window)) { toast("This browser doesn't support notifications."); return; }
  if (Notification.permission === "granted") {
    new Notification("Reminders are on ✅", { body: "You'll be nudged before things are due.", icon: "icon.svg" });
  } else if (Notification.permission === "denied") {
    toast("Notifications are blocked. Enable them in your browser's site settings.");
  } else {
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      new Notification("Reminders are on ✅", { body: "You'll be nudged before things are due.", icon: "icon.svg" });
    }
  }
  updateReminderButton();
}

/** Scan the near future and fire any reminders that are due. Runs periodically. */
function reminderTick() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const now = new Date();
  const rangeStart = new Date(now); rangeStart.setDate(rangeStart.getDate() - 3);
  const rangeEnd = new Date(now); rangeEnd.setDate(rangeEnd.getDate() + 3);

  for (const occ of occurrencesInRange(rangeStart, rangeEnd)) {
    const item = occ.item;
    if (item.reminderMinutesBefore < 0) continue;   // "No reminder"
    if (isDone(occ)) continue;
    if (state.notified[occ.key]) continue;

    const due = toDateTime(occ.date, item.time || "09:00");
    const remindAt = new Date(due.getTime() - item.reminderMinutesBefore * 60000);

    // Fire once we've reached the reminder time, but not if it's more than 6h stale
    // (e.g. app was closed) — avoids a burst of old notifications on open.
    if (now >= remindAt && now - remindAt < 6 * 3600 * 1000) {
      showReminder(occ, due);
      state.notified[occ.key] = true;
      saveState();
    }
  }
}

function showReminder(occ, due) {
  const item = occ.item;
  const subj = subjectById(item.subjectId);
  const meta = TYPE_META[item.type];
  const whenTxt = item.time ? ` at ${fmtTime(item.time)}` : "";
  const rel = occ.date === todayStr() ? "today" : dashWhen(occ).toLowerCase();
  const body = `${subj.name} · ${meta.label}\nDue ${rel}${whenTxt}`;
  try {
    const n = new Notification(`${meta.icon} ${item.title}`, { body, icon: "icon.svg", tag: occ.key });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (err) {
    console.error("Notification failed:", err);
  }
}

/* =========================================================================
 * Quick-add (speak/type a sentence → scheduled item(s), parsed on-device)
 * Parsing lives in quickadd.js (parseQuickAdd) — free, offline, no account.
 * ========================================================================= */
function handleQuickAdd(text) {
  text = (text || "").trim();
  if (!text) return;

  let created = [];
  try {
    const drafts = parseQuickAdd(text, state.subjects, new Date());
    created = createItemsFromDrafts(drafts);
  } catch (err) {
    console.error("Quick add failed:", err);
    showQAError("Sorry — couldn't read that. Try rephrasing, or add it manually.", true);
    return;
  }
  if (!created.length) {
    showQAError("Couldn't work out what to add. Try including a date, or add it manually.", true);
    return;
  }
  renderAll();
  showQAAdded(created);
  $("#qa-input").value = "";
}

/** Turn validated drafts into real items (creating subjects as needed). */
function createItemsFromDrafts(drafts) {
  const created = [];
  for (const d of drafts || []) {
    const type = ["homework", "test", "event"].includes(d.type) ? d.type : "homework";
    const title = String(d.title || "").trim().slice(0, 120);
    const date = normalizeDate(d.date);
    if (!title || !date) continue;

    const rec = d.recurrence || {};
    const recFreq = ["none", "daily", "weekly", "monthly"].includes(rec.freq) ? rec.freq : "none";
    const reminder = Number.isFinite(d.reminderMinutesBefore)
      ? Math.round(d.reminderMinutesBefore)
      : (type === "test" ? 1440 : 60);

    const item = stamp({
      id: uid(),
      createdAt: Date.now(),
      completedDates: [],
      type,
      title,
      subjectId: resolveSubject(d.subjectName),
      date,
      time: normalizeTime(d.time),
      reminderMinutesBefore: reminder,
      notes: "",
      recurrence: { freq: recFreq, until: recFreq === "none" ? null : normalizeDate(rec.until) },
    });
    state.items.push(item);
    created.push(item);
  }
  if (created.length) saveState();
  return created;
}

/** Map a subject name to an existing subject id, or create a new colour-coded one. */
function resolveSubject(name) {
  const active = activeSubjects();
  const fallback = active[0] && active[0].id;
  const raw = String(name || "").trim();
  if (!raw) return fallback;

  const subj = active.find((s) => s.name.toLowerCase() === raw.toLowerCase());
  if (subj) return subj.id;

  const created = stamp({
    id: uid(),
    name: raw.slice(0, 40),
    color: SUBJECT_PALETTE[active.length % SUBJECT_PALETTE.length],
  });
  state.subjects.push(created);
  return created.id;
}

function normalizeDate(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], da = +m[3];
  const d = new Date(y, mo - 1, da);
  // Reject impossible dates (e.g. 2026-02-30 rolls over).
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) return null;
  return toDateStr(d);
}
function normalizeTime(s) {
  if (typeof s !== "string") return "";
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return "";
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return "";
  return String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0");
}

/* ---------- Quick-add result UI ---------- */
function qaResultReset() {
  const el = $("#qa-result");
  el.hidden = false;
  el.innerHTML = "";
  return el;
}
function showQAError(msg, offerManual) {
  const el = qaResultReset();
  const d = document.createElement("div");
  d.className = "qa-error";
  d.append(document.createTextNode(msg + " "));
  if (offerManual) {
    const link = document.createElement("span");
    link.className = "link";
    link.textContent = "Add manually";
    link.addEventListener("click", () => { modalContext.dayDate = null; openItemModal(null); });
    d.appendChild(link);
  }
  el.appendChild(d);
}
function showQAAdded(items) {
  const el = qaResultReset();
  for (const item of items) {
    const occ = { item, date: item.date, key: `${item.id}@${item.date}` };
    const subj = subjectById(item.subjectId);
    const meta = TYPE_META[item.type];

    const row = document.createElement("div");
    row.className = "qa-added";

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = subj.color;

    const main = document.createElement("div");
    main.className = "qa-added-main";
    const title = document.createElement("div");
    title.className = "qa-added-title";
    title.textContent = `${meta.icon} ${item.title}`;
    const sub = document.createElement("div");
    sub.className = "qa-added-meta";
    sub.innerHTML =
      `<span class="type-pill">${meta.label}</span>` +
      `<span>${subj.name}</span>` +
      `<span>${dashWhen(occ)}</span>`;
    main.append(title, sub);

    const actions = document.createElement("div");
    actions.className = "qa-added-actions";
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn btn-ghost";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openItemModal(item));
    const undoBtn = document.createElement("button");
    undoBtn.type = "button";
    undoBtn.className = "btn btn-danger";
    undoBtn.textContent = "Undo";
    undoBtn.addEventListener("click", () => {
      undoQuickAddItem(item.id);
      row.remove();
      if (!$("#qa-result").children.length) $("#qa-result").hidden = true;
    });
    actions.append(editBtn, undoBtn);

    row.append(dot, main, actions);
    el.appendChild(row);
  }
}
function undoQuickAddItem(id) {
  const item = state.items.find((i) => i.id === id);
  if (item) tombstone(item);
  saveState();
  renderAll();
  toast("Removed");
}

/* ---------- Voice input (browser speech recognition) ---------- */
let recognition = null;
let listening = false;
function initVoiceInput() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $("#qa-mic");
  if (!SR) { mic.hidden = true; return; }

  recognition = new SR();
  recognition.lang = "en-AU";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.continuous = false;

  recognition.addEventListener("result", (e) => {
    const transcript = Array.from(e.results)
      .map((r) => r[0].transcript)
      .join(" ")
      .trim();
    if (transcript) {
      $("#qa-input").value = transcript;
      handleQuickAdd(transcript);
    }
  });
  recognition.addEventListener("error", (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      toast("Microphone is blocked — allow it in your browser settings.");
    } else if (e.error !== "aborted" && e.error !== "no-speech") {
      toast("Voice input error: " + e.error);
    }
  });
  recognition.addEventListener("end", () => {
    listening = false;
    mic.classList.remove("listening");
  });

  mic.addEventListener("click", () => {
    if (listening) { recognition.stop(); return; }
    try {
      recognition.start();
      listening = true;
      mic.classList.add("listening");
    } catch (_) { /* start() throws if already running; ignore */ }
  });
}

/* =========================================================================
 * Backup: export to a file, import one back in
 *
 * A browser keeps storage separately per web address, so the copy that lived
 * at localhost can't be seen by the published site. These two buttons carry
 * items across that gap, and double as a plain backup.
 * ========================================================================= */
function exportBackup() {
  const payload = {
    app: "vce-organiser",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    subjects: state.subjects,
    items: state.items,
    notified: state.notified,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `vce-organiser-backup-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);

  const n = activeItems().length;
  toast(`Exported ${n} item${n === 1 ? "" : "s"} — check your Downloads.`);
}

function handleImportFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = () => toast("Couldn't read that file.");
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch (err) {
      toast("That file isn't a valid backup.");
      return;
    }
    const result = importBackup(data);
    if (!result) { toast("That doesn't look like a VCE Organiser backup."); return; }

    saveState();                       // pushes to the cloud if signed in
    renderAll();
    if ($("#item-modal").hidden) populateSubjectDropdown();

    const bits = [`Imported ${result.items} item${result.items === 1 ? "" : "s"}`];
    if (result.subjects) bits.push(`${result.subjects} new subject${result.subjects === 1 ? "" : "s"}`);
    if (result.skipped) bits.push(`${result.skipped} already here`);
    toast(bits.join(" · "));
  };
  reader.readAsText(file);
}

/**
 * Merge a backup into the current organiser. Nothing is replaced: items
 * already present are left alone, and incoming subjects are matched to
 * existing ones by name so importing doesn't double up your subject list.
 *
 * @returns {{items:number, subjects:number, skipped:number}|null}
 */
function importBackup(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.items)) return null;
  normalizeStamps(data);

  const byName = new Map(
    activeSubjects().map((s) => [String(s.name || "").trim().toLowerCase(), s.id])
  );
  const remap = new Map();
  let addedSubjects = 0;

  for (const sub of data.subjects || []) {
    if (!sub || !sub.id || sub.deleted) continue;
    const key = String(sub.name || "").trim().toLowerCase();
    const existing = byName.get(key);
    if (existing) { remap.set(sub.id, existing); continue; }
    if (state.subjects.some((s) => s.id === sub.id)) { remap.set(sub.id, sub.id); continue; }
    state.subjects.push(stamp(Object.assign({}, sub)));
    byName.set(key, sub.id);
    remap.set(sub.id, sub.id);
    addedSubjects++;
  }

  const have = new Set(state.items.map((i) => i.id));
  const fallbackSubject = activeSubjects()[0] && activeSubjects()[0].id;
  let added = 0, skipped = 0;

  for (const item of data.items) {
    if (!item || !item.id || !item.title || !item.date || item.deleted) continue;
    if (have.has(item.id)) { skipped++; continue; }
    const copy = Object.assign({}, item);
    copy.subjectId = remap.get(copy.subjectId) || fallbackSubject;
    copy.completedDates = Array.isArray(copy.completedDates) ? copy.completedDates : [];
    state.items.push(stamp(copy));
    have.add(copy.id);
    added++;
  }

  for (const key of Object.keys(data.notified || {})) state.notified[key] = true;
  dedupeSubjectsByName(state);

  return { items: added, subjects: addedSubjects, skipped };
}

/* =========================================================================
 * Cloud sync UI
 * ========================================================================= */
const SYNC_LOOK = {
  "off":        { icon: "☁", label: "Local only" },
  "signed-out": { icon: "☁", label: "Sign in" },
  "connecting": { icon: "⟳", label: "Syncing…" },
  "synced":     { icon: "✔", label: "Synced" },
  "offline":    { icon: "⚠", label: "Offline" },
  "error":      { icon: "⚠", label: "Sync issue" },
};

let lastSyncState = null;
function renderSyncButton(status) {
  const btn = $("#sync-btn");
  if (!btn) return;
  const look = SYNC_LOOK[status.state] || SYNC_LOOK.off;
  btn.querySelector(".sync-icon").textContent = look.icon;
  btn.querySelector(".btn-label").textContent = look.label;
  btn.title = status.detail || look.label;
  btn.classList.toggle("on", status.state === "synced");
  btn.classList.toggle("warn", status.state === "offline" || status.state === "error");
  btn.classList.toggle("spinning", status.state === "connecting");

  // Surface real problems once, rather than leaving them only in the tooltip.
  if (status.state === "error" && lastSyncState !== "error" && status.detail) toast(status.detail);
  lastSyncState = status.state;
}

function handleSyncClick() {
  const sync = window.OrgSync;
  if (!sync || !sync.configured) {
    toast("Cloud sync isn't set up yet — follow SETUP.md.");
    return;
  }
  if (sync.user) {
    const who = sync.user.email || "your Google account";
    const msg = `Signed in as ${who}.\n\nSign out on this device? Your organiser stays safe in the cloud.`;
    if (window.confirm(msg)) sync.signOut();
  } else {
    sync.signIn();
  }
}

function initSync() {
  if (!window.OrgSync) return;
  renderSyncButton({
    state: window.OrgSync.configured ? "connecting" : "off",
    detail: "",
  });
  window.OrgSync.init({
    getState: () => state,
    applyRemote: applyRemoteState,
    onStatus: renderSyncButton,
  });
}

/* =========================================================================
 * Modal plumbing
 * ========================================================================= */
function openModal(id) { $("#" + id).hidden = false; }
function closeModal(id) { $("#" + id).hidden = true; }

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

/* =========================================================================
 * Wiring
 * ========================================================================= */
function bindEvents() {
  $("#add-item").addEventListener("click", () => { modalContext.dayDate = null; openItemModal(null); });
  $("#manage-subjects").addEventListener("click", () => { renderSubjectManager(); openModal("subjects-modal"); });
  $("#enable-reminders").addEventListener("click", requestNotifications);
  $("#sync-btn").addEventListener("click", handleSyncClick);

  $("#export-data").addEventListener("click", exportBackup);
  $("#import-data").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", (e) => {
    handleImportFile(e.target.files && e.target.files[0]);
    e.target.value = "";           // let the same file be picked again
  });

  // Quick-add
  $("#qa-form").addEventListener("submit", (e) => { e.preventDefault(); handleQuickAdd($("#qa-input").value); });

  $("#cal-prev").addEventListener("click", () => shiftMonth(-1));
  $("#cal-next").addEventListener("click", () => shiftMonth(1));
  $("#cal-today").addEventListener("click", () => {
    const now = new Date();
    viewYear = now.getFullYear(); viewMonth = now.getMonth();
    renderCalendar(viewYear, viewMonth);
  });

  $("#item-form").addEventListener("submit", saveItemFromForm);
  $("#item-delete").addEventListener("click", deleteCurrentItem);
  $("#item-recurrence").addEventListener("change", updateRecurrenceUntilVisibility);

  $("#add-subject-form").addEventListener("submit", addSubjectFromForm);

  $("#day-add").addEventListener("click", () => { closeModal("day-modal"); openItemModal(null); });

  // Any element with data-close-modal closes its named modal.
  $$("[data-close-modal]").forEach((el) => {
    el.addEventListener("click", () => closeModal(el.dataset.closeModal));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $$(".modal").forEach((m) => (m.hidden = true));
  });
}

function shiftMonth(delta) {
  viewMonth += delta;
  if (viewMonth < 0) { viewMonth = 11; viewYear--; }
  else if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  renderCalendar(viewYear, viewMonth);
}

/* ---------- Service worker (PWA) ---------- */
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch((err) =>
        console.warn("Service worker registration failed:", err)
      );
    });
  }
}

/* ---------- Init ---------- */
function init() {
  loadState();
  const now = new Date();
  viewYear = now.getFullYear();
  viewMonth = now.getMonth();

  bindEvents();
  initVoiceInput();
  updateReminderButton();
  renderAll();
  initSync();

  reminderTick();
  setInterval(reminderTick, 30000); // check every 30s while app is open
  registerServiceWorker();
}

document.addEventListener("DOMContentLoaded", init);
