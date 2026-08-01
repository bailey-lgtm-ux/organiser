/* =========================================================================
 * VCE Organiser — offline quick-add parser
 * Pure functions: no DOM, no network, no cost. Turns a plain sentence like
 * "physics exam on the 30th of July" into schedule-item drafts the app saves.
 *
 * Entry point:
 *   parseQuickAdd(text, subjects, now)
 *     -> [ { type, title, subjectName, date, time, reminderMinutesBefore, recurrence } ]
 *   where date is "YYYY-MM-DD", time is "HH:MM" (or ""), recurrence is { freq, until }.
 * ========================================================================= */

"use strict";

const QA_MONTHS = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sept: 8, sep: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};
const QA_WEEKDAYS = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2, wednesday: 3, wed: 3,
  thursday: 4, thurs: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};

/* Spoken shorthands → canonical VCE subject names. */
const QA_SUBJECT_ALIASES = {
  methods: "Maths Methods", "maths methods": "Maths Methods", math: "Maths Methods", maths: "Maths Methods",
  spesh: "Specialist Maths", "specialist maths": "Specialist Maths",
  "further maths": "Further Maths", further: "Further Maths",
  chem: "Chemistry", bio: "Biology", eng: "English", lit: "Literature",
  psych: "Psychology", pe: "Physical Education", "phys ed": "Physical Education",
  "phys ed.": "Physical Education", legal: "Legal Studies", "legal studies": "Legal Studies",
  "bus man": "Business Management", "business management": "Business Management",
  "software": "Software Development", it: "Information Technology",
};

/* Common VCE subjects the parser recognises even before they've been added. */
const QA_SUBJECT_WORDS = [
  "english", "literature", "specialist maths", "further maths", "maths", "math",
  "biology", "chemistry", "physics", "psychology", "history", "geography", "economics",
  "accounting", "business management", "legal studies", "politics", "philosophy",
  "physical education", "health", "food studies", "studio art", "visual communication",
  "media", "music", "drama", "theatre", "french", "german", "japanese", "chinese",
  "italian", "latin", "software development", "information technology", "computing",
  "religion", "sociology", "art",
];

/* ------------------------------------------------------------------ */
function parseQuickAdd(text, subjects, now) {
  now = now instanceof Date ? now : new Date();
  subjects = subjects || [];
  const drafts = [];
  for (const seg of qaSplitSegments(text)) {
    const d = qaParseOne(seg, subjects, now);
    if (d) drafts.push(d);
  }
  return drafts;
}

/* Split into separate tasks conservatively: on sentence marks, "and then",
 * and " and " only when a new task clearly begins ("...and a physics exam..."). */
function qaSplitSegments(text) {
  return String(text || "")
    .split(/[\n.;]+|\s+and then\s+|\s+and\s+(?=(?:a|an|another|the|i)\s)/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

function qaParseOne(seg, subjects, now) {
  let s = " " + seg.toLowerCase().replace(/\s+/g, " ").trim() + " ";
  if (!s.trim()) return null;

  const type = qaDetectType(s);
  const rec = qaDetectRecurrence(s);
  s = rec.s;

  const dateRes = qaExtractDate(s, now);
  s = dateRes.s;

  const timeRes = qaExtractTime(s);
  s = timeRes.s;

  const subjRes = qaExtractSubject(s, subjects);
  s = subjRes.s;

  const date = dateRes.date || qaToStr(qaMidnight(now)); // default to today when unspecified
  const time = timeRes.time || dateRes.timeHint || "";
  const title = qaCleanTitle(s, subjRes.subjectName, type);

  return {
    type,
    title,
    subjectName: subjRes.subjectName,
    date,
    time,
    reminderMinutesBefore: type === "test" ? 1440 : 60,
    recurrence: { freq: rec.freq, until: null },
  };
}

/* ---------- Type ---------- */
function qaDetectType(s) {
  if (/\b(exam|test|sac|s\.a\.c|quiz|assessment)\b/.test(s)) return "test";
  if (/\b(excursion|incursion|meeting|appointment|assembly|presentation|concert|camp|formal|dance|interview|performance|rehearsal|birthday|party|holiday|event|footy|game|practice|training)\b/.test(s)) return "event";
  return "homework";
}

/* ---------- Recurrence (also strips the words) ---------- */
function qaDetectRecurrence(s) {
  let freq = "none";
  let m;
  if ((m = s.match(/\b(every ?day|daily|each day)\b/))) { freq = "daily"; s = qaRemove(s, m); }
  else if ((m = s.match(/\b(every week|weekly|each week)\b/))) { freq = "weekly"; s = qaRemove(s, m); }
  else if ((m = s.match(/\bevery (sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thu|friday|fri|saturday|sat)\b/))) { freq = "weekly"; s = qaRemove(s, m); }
  else if ((m = s.match(/\b(every month|monthly|each month)\b/))) { freq = "monthly"; s = qaRemove(s, m); }
  return { freq, s };
}

/* ---------- Date (returns { date, timeHint, s }) ---------- */
function qaExtractDate(s, now) {
  const today = qaMidnight(now);
  let date = null;
  let timeHint = "";
  let m;

  if ((m = s.match(/\bday after tomorrow\b/))) { date = qaAddDays(today, 2); s = qaRemove(s, m); }
  else if ((m = s.match(/\btomorrow(?:\s+(morning|afternoon|arvo|evening|night))?\b/))) {
    date = qaAddDays(today, 1); timeHint = qaPartTime(m[1]); s = qaRemove(s, m);
  } else if ((m = s.match(/\btonight\b/))) { date = today; timeHint = "19:00"; s = qaRemove(s, m); }
  else if ((m = s.match(/\btoday\b/))) { date = today; s = qaRemove(s, m); }
  else if ((m = s.match(/\bthis (morning|afternoon|arvo|evening)\b/))) {
    date = today; timeHint = qaPartTime(m[1]); s = qaRemove(s, m);
  }

  if (!date && (m = s.match(/\bin (\d+) (day|days|week|weeks)\b/))) {
    const n = +m[1];
    date = qaAddDays(today, m[2].indexOf("week") === 0 ? n * 7 : n);
    s = qaRemove(s, m);
  }

  if (!date && (m = s.match(/\b(this|next)?\s*(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thu|friday|fri|saturday|sat)\b/))) {
    date = qaNextWeekday(today, QA_WEEKDAYS[m[2]], /next/.test(m[1] || ""));
    s = qaRemove(s, m);
  }

  // "28th of July" / "28 July"
  if (!date && (m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b/))) {
    date = qaMonthDay(today, QA_MONTHS[m[2]], +m[1]); s = qaRemove(s, m);
  }
  // "July 28"
  if (!date && (m = s.match(/\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b/))) {
    date = qaMonthDay(today, QA_MONTHS[m[1]], +m[2]); s = qaRemove(s, m);
  }
  // ISO YYYY-MM-DD
  if (!date && (m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) {
    date = qaMakeDate(+m[1], +m[2] - 1, +m[3]); s = qaRemove(s, m);
  }
  // Australian day-first D/M or D/M/YY(YY)
  if (!date && (m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    const day = +m[1], mon = +m[2] - 1;
    let yr = m[3] ? +m[3] : today.getFullYear();
    if (m[3] && m[3].length === 2) yr += 2000;
    date = qaMakeDate(yr, mon, day);
    if (!m[3] && date < today) date = qaMakeDate(yr + 1, mon, day);
    s = qaRemove(s, m);
  }
  // Day-only, but only with an ordinal suffix so "questions 3 and 4" is never a date.
  if (!date && (m = s.match(/\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/))) {
    date = qaNextDayOfMonth(today, +m[1]); s = qaRemove(s, m);
  }

  return { date: date ? qaToStr(date) : null, timeHint, s };
}

/* ---------- Time (returns { time, s }) ---------- */
function qaExtractTime(s) {
  let m, time = "";
  if ((m = s.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/))) {
    let h = +m[1]; const min = m[2] ? +m[2] : 0; const pm = /p/.test(m[3]);
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
    time = qaHHMM(h, min); s = qaRemove(s, m);
  } else if ((m = s.match(/\b(?:at\s+)?(\d{1,2}):(\d{2})\b/))) {
    time = qaHHMM(+m[1], +m[2]); s = qaRemove(s, m);
  } else if ((m = s.match(/\bat\s+(\d{1,2})\b/))) {
    let h = +m[1]; if (h >= 1 && h <= 7) h += 12; // 1–7 "at N" almost always means afternoon/evening
    time = qaHHMM(h, 0); s = qaRemove(s, m);
  } else if ((m = s.match(/\b(midday|noon)\b/))) { time = "12:00"; s = qaRemove(s, m); }
  else if ((m = s.match(/\bmidnight\b/))) { time = "00:00"; s = qaRemove(s, m); }
  else if ((m = s.match(/\b(morning|afternoon|arvo|evening|night)\b/))) { time = qaPartTime(m[1]); s = qaRemove(s, m); }
  return { time, s };
}

/* ---------- Subject (returns { subjectName, s }) ---------- */
function qaExtractSubject(s, subjects) {
  const cands = [];
  for (const subj of subjects || []) cands.push({ match: subj.name.toLowerCase(), name: subj.name });
  for (const k in QA_SUBJECT_ALIASES) cands.push({ match: k, name: QA_SUBJECT_ALIASES[k] });
  for (const w of QA_SUBJECT_WORDS) cands.push({ match: w, name: qaTitleCase(w) });
  cands.sort((a, b) => b.match.length - a.match.length); // prefer "specialist maths" over "maths"

  for (const c of cands) {
    const m = s.match(new RegExp("\\b" + qaEscape(c.match) + "\\b"));
    if (m) { s = qaRemove(s, m); return { subjectName: c.name, s }; }
  }
  return { subjectName: "", s };
}

/* ---------- Title ---------- */
const QA_FILLER = /\b(i have to|i have a|i have got|i've got a|i've got|i have|i need to|i gotta|i wanna|remember to|don't forget to|dont forget to|there's a|there is a|do my|do the|need to|have to|got a|gotta|please|add|schedule|set|put in|for my|for|my|the|a|an|on|at|by|due|this|next|of|to|is|about)\b/g;

function qaCleanTitle(s, subjectName, type) {
  let leftover = (" " + s + " ").replace(QA_FILLER, " ").replace(/\s+/g, " ").trim();
  leftover = leftover.replace(/^[\s,;:.\-]+|[\s,;:.\-]+$/g, "");

  const meaty = leftover.replace(/\b(exam|test|sac|quiz|assessment|homework|assignment)\b/g, "").trim();
  let title;
  if (meaty.length >= 2) title = leftover;
  else if (subjectName) title = subjectName + " " + (leftover || qaTypeNoun(type));
  else title = leftover || qaTypeNoun(type);

  return qaCapFirst(title).slice(0, 120);
}
function qaTypeNoun(type) {
  return type === "test" ? "Test" : type === "event" ? "Event" : "Homework";
}

/* ---------- Date/format helpers (self-contained for headless testing) ---------- */
function qaMidnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function qaAddDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function qaMakeDate(y, mo, da) { return new Date(y, mo, da); }
function qaNextWeekday(today, wd, forceNext) {
  const x = new Date(today);
  let diff = (wd - x.getDay() + 7) % 7;
  if (diff === 0) diff = 7; // always land on a future day
  x.setDate(x.getDate() + diff + (forceNext ? 7 : 0));
  return x;
}
function qaMonthDay(today, mo, day) {
  let x = new Date(today.getFullYear(), mo, day);
  if (x < today) x = new Date(today.getFullYear() + 1, mo, day);
  return x;
}
function qaNextDayOfMonth(today, day) {
  let x = new Date(today.getFullYear(), today.getMonth(), day);
  if (x < today || x.getDate() !== day) x = new Date(today.getFullYear(), today.getMonth() + 1, day);
  return x;
}
function qaToStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function qaPartTime(word) {
  if (!word) return "";
  if (/morning/.test(word)) return "09:00";
  if (/afternoon|arvo/.test(word)) return "15:00";
  if (/evening|night/.test(word)) return "19:00";
  return "";
}
function qaHHMM(h, min) {
  h = Math.max(0, Math.min(23, h));
  min = Math.max(0, Math.min(59, min));
  return String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0");
}
function qaRemove(s, m) { return s.slice(0, m.index) + " " + s.slice(m.index + m[0].length); }
function qaEscape(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function qaTitleCase(w) { return w.replace(/\b\w/g, (c) => c.toUpperCase()); }
function qaCapFirst(w) { return w ? w.charAt(0).toUpperCase() + w.slice(1) : w; }

/* Export for headless test runners (jsc/node); ignored in the browser. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseQuickAdd };
}
