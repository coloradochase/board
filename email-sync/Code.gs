/**
 * Chasyn Email Sync
 * Every 15 minutes: reads recent Primary-inbox threads, asks Gemini which ones are
 * Chasyn business and to title + summarize them, then saves those cards to the
 * private "emails" section of the chasyn-board Firebase database.
 *
 * Setup (once):
 *   1. Project Settings > Script Properties > add GEMINI_API_KEY = your key from aistudio.google.com
 *   2. Run setup() and approve the permissions.
 * To keep a thread off the board, give it the Gmail label  hide-from-board
 */

var PROJECT_ID = 'chasyn-board';
var LOOKBACK_DAYS = 14;
var MAX_THREADS = 40;
var HIDE_LABEL = 'hide-from-board';
var BATCH = 5;
var TIME_BUDGET_MS = 4.5 * 60 * 1000;   // Apps Script stops runs at 6 minutes; save and stop before that
var MODELS = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest'];   // fast, cheap models; first one that exists is used
var TEAM = 'Becca Haddad (manager, beccahaddadmgmt@gmail.com), Sam (sam@consigmgmt.com), Carson Becker (carson@carsonbecker.com)';

var FS = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents';

// ---------- entry points ----------
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncEmails').timeBased().everyMinutes(15).create();
  syncEmails();
}

function syncEmails() {
  var started = Date.now();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { Logger.log('Another sync is still running; skipping.'); return; }
  try { runSync(started); } finally { lock.releaseLock(); }
}

function runSync(started) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('Add GEMINI_API_KEY under Project Settings > Script Properties.');
  var me = Session.getEffectiveUser().getEmail().toLowerCase();

  var seen = {};
  try { seen = JSON.parse(props.getProperty('SEEN') || '{}'); } catch (e) {}

  var q = 'category:primary newer_than:' + LOOKBACK_DAYS + 'd -in:chats -label:' + HIDE_LABEL;
  var list = Gmail.Users.Threads.list('me', { q: q, maxResults: MAX_THREADS }).threads || [];

  var next = {}, todo = [];
  list.forEach(function (t) {
    if (seen[t.id] && seen[t.id].h === t.historyId) next[t.id] = seen[t.id];
    else todo.push(t);
  });
  Logger.log(list.length + ' threads, ' + todo.length + ' new or changed');

  var finished = true;
  for (var i = 0; i < todo.length; i += BATCH) {
    if (Date.now() - started > TIME_BUDGET_MS) { finished = false; break; }
    var batch = todo.slice(i, i + BATCH).map(function (t) { return describe(t.id, t.historyId, me); });
    var t0 = Date.now();
    var results;
    try { results = askGemini(key, batch, me); }
    catch (e) { Logger.log('Gemini unavailable, will retry next run: ' + e.message.slice(0, 200)); finished = false; break; }
    Logger.log('Gemini batch of ' + batch.length + ' took ' + Math.round((Date.now() - t0) / 1000) + 's');
    batch.forEach(function (b) {
      var r = results.filter(function (x) { return x.id === b.id; })[0];
      var relevant = !!(r && r.relevant && r.title);
      next[b.id] = { h: b.historyId, r: relevant ? 1 : 0 };
      if (relevant) {
        writeDoc('emails/' + b.id, {
          title: clip(r.title, 60),
          summary: clip(r.summary || '', 240),
          status: ['Needs reply', 'Waiting on them', 'FYI'].indexOf(r.status) >= 0 ? r.status : 'FYI',
          people: b.people,
          subject: b.subject,
          lastDate: b.lastDate,
          link: 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(me) + '#all/' + b.id
        });
      }
    });
    // Save progress after every batch so a stopped run never redoes finished work.
    var progress = {};
    Object.keys(seen).forEach(function (id) { progress[id] = seen[id]; });
    Object.keys(next).forEach(function (id) { progress[id] = next[id]; });
    props.setProperty('SEEN', JSON.stringify(progress));
  }

  if (!finished) {
    Logger.log('Out of time; the next run continues where this one stopped.');
    writeDoc('emailsMeta/status', { lastRun: Date.now(), count: -1 });
    return;
  }

  // Remove cards for threads that aged out, were hidden, or stopped being business.
  var keep = {};
  Object.keys(next).forEach(function (id) { if (next[id].r) keep[id] = true; });
  listDocIds('emails').forEach(function (id) { if (!keep[id]) deleteDoc('emails/' + id); });

  writeDoc('emailsMeta/status', { lastRun: Date.now(), count: Object.keys(keep).length });
  props.setProperty('SEEN', JSON.stringify(next));
  Logger.log('Done: ' + Object.keys(keep).length + ' Chasyn threads on the board');
}

// Quick check that the Gemini key works (run from the editor).
function testGemini() {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  var t0 = Date.now();
  var r = askGemini(key, [{ id: 'test', subject: 'Booking inquiry', messages: [{ from: 'Promoter <p@example.com>', date: new Date().toISOString(), text: 'Hi Chasyn, are you free to play our venue on March 3? Fee is $1,500.' }] }], 'me@example.com');
  Logger.log(JSON.stringify(r) + ' in ' + Math.round((Date.now() - t0) / 1000) + 's');
}

// ---------- Gmail ----------
function describe(id, historyId, me) {
  var t = Gmail.Users.Threads.get('me', id, { format: 'full' });
  var msgs = t.messages || [];
  var people = {}, subject = '', out = [];
  msgs.forEach(function (m, i) {
    var h = headers(m.payload);
    if (i === 0) subject = h.subject || '(no subject)';
    [h.from, h.to, h.cc].forEach(function (v) { addresses(v).forEach(function (a) {
      if (a.email !== me && !people[a.email]) people[a.email] = a.name || a.email.split('@')[0];
    }); });
  });
  msgs.slice(-4).forEach(function (m) {
    var h = headers(m.payload);
    out.push({ from: h.from || '', date: new Date(Number(m.internalDate)).toISOString(), text: clip(stripQuoted(bodyText(m.payload)), 1200) });
  });
  return {
    id: id, historyId: historyId, subject: subject,
    lastDate: msgs.length ? Number(msgs[msgs.length - 1].internalDate) : Date.now(),
    people: Object.keys(people).slice(0, 5).map(function (k) { return people[k]; }),
    messages: out
  };
}

function headers(payload) {
  var h = {};
  (payload && payload.headers || []).forEach(function (x) { h[x.name.toLowerCase()] = x.value; });
  return h;
}

function addresses(v) {
  if (!v) return [];
  var re = /(?:"?([^"<,]*?)"?\s*<([^>]+)>)|([^\s,<>"]+@[^\s,<>"]+)/g, m, out = [];
  while ((m = re.exec(v))) out.push({ name: (m[1] || '').trim(), email: (m[2] || m[3] || '').trim().toLowerCase() });
  return out;
}

function bodyText(p) {
  if (!p) return '';
  if (p.mimeType === 'text/plain' && p.body && p.body.data) return decode(p.body.data);
  var parts = p.parts || [], i, s;
  for (i = 0; i < parts.length; i++) if (parts[i].mimeType === 'text/plain') { s = bodyText(parts[i]); if (s) return s; }
  for (i = 0; i < parts.length; i++) { s = bodyText(parts[i]); if (s) return s; }
  if (p.mimeType === 'text/html' && p.body && p.body.data) {
    return decode(p.body.data).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  }
  return '';
}
function decode(d) {
  try {
    d = String(d).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
    while (d.length % 4) d += '=';
    return Utilities.newBlob(Utilities.base64Decode(d)).getDataAsString('UTF-8');
  } catch (e) { return ''; }
}

function stripQuoted(s) {
  s = s.split(/\n(?:On .{5,200}wrote:|-{2,}\s*Original Message|From: .+\r?\nSent: )/)[0];
  return s.split('\n').filter(function (l) { return l.charAt(0) !== '>'; }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- Gemini ----------
function askGemini(key, batch, me) {
  var prompt =
    'You keep a team dashboard of active email for Chase Nutting, a Denver DJ and multi-instrumentalist who performs as Chasyn. ' +
    'His email is ' + me + '. His team: ' + TEAM + '.\n\n' +
    'For each thread below decide "relevant": true only for Chasyn music business, such as bookings, shows, venues, promoters, ' +
    'festivals, colleges, collaborations, artists, labels, distribution, brand deals, sponsorships, gear partnerships, press, ' +
    'content, management, contracts and gig payments. false for receipts, shipping, newsletters, marketing, automated ' +
    'notifications, account or security mail, and personal, family or medical mail.\n' +
    'For relevant threads also write:\n' +
    '- "title": "Chasyn × <counterpart>", where counterpart is the company, artist, venue or person on the other side. Max 40 characters.\n' +
    '- "summary": one or two plain sentences on where things stand and the next step. Max 200 characters. No em dashes.\n' +
    '- "status": "Needs reply" if the latest message came from someone outside Chase\'s team and asks something of him; ' +
    '"Waiting on them" if Chase or his team sent the latest message; otherwise "FYI".\n' +
    'For threads that are not relevant, return only id and relevant.\n\n' +
    'Threads (JSON):\n' + JSON.stringify(batch.map(function (b) {
      return { id: b.id, subject: b.subject, messages: b.messages };
    }));

  var body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      thinkingConfig: { thinkingLevel: 'minimal' },   // short summaries don't need slow "thinking"
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            id: { type: 'STRING' }, relevant: { type: 'BOOLEAN' },
            title: { type: 'STRING' }, summary: { type: 'STRING' },
            status: { type: 'STRING', enum: ['Needs reply', 'Waiting on them', 'FYI'] }
          },
          required: ['id', 'relevant']
        }
      }
    }
  };

  var lastErr = '';
  for (var i = 0; i < MODELS.length; i++) {
    var res, code;
    for (var attempt = 0; attempt < 2; attempt++) {
      res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + MODELS[i] + ':generateContent', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { 'x-goog-api-key': key }, payload: JSON.stringify(body)
      });
      code = res.getResponseCode();
      if (code !== 429 && code < 500) break;
      Utilities.sleep(4000);   // busy or rate-limited: wait and try once more
    }
    if (code === 429 || code >= 500) { lastErr = MODELS[i] + ' busy (' + code + ')'; continue; }   // try the backup model
    if (code === 404) { lastErr = MODELS[i] + ' not found'; continue; }
    if (code === 400 && /thinking/i.test(res.getContentText()) && body.generationConfig.thinkingConfig) {
      delete body.generationConfig.thinkingConfig; i--; continue;   // model doesn't accept that setting; retry without it
    }
    if (code >= 300) throw new Error('Gemini ' + code + ': ' + res.getContentText().slice(0, 300));
    var json = JSON.parse(res.getContentText());
    var text = json.candidates && json.candidates[0] && json.candidates[0].content.parts[0].text;
    try { return JSON.parse(text) || []; } catch (e) { return []; }
  }
  throw new Error('No Gemini model available: ' + lastErr);
}

// ---------- Firestore (runs as you, the project owner) ----------
function fsFetch(url, method, payload) {
  var opts = {
    method: method, muteHttpExceptions: true, contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Goog-User-Project': PROJECT_ID }
  };
  if (payload) opts.payload = JSON.stringify(payload);
  var res = UrlFetchApp.fetch(url, opts);
  if (res.getResponseCode() >= 300 && res.getResponseCode() !== 404) {
    throw new Error('Firestore ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  return res.getResponseCode() === 404 ? null : JSON.parse(res.getContentText() || '{}');
}

function toValue(v) {
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  return { stringValue: String(v) };
}
function writeDoc(path, obj) {
  var fields = {};
  Object.keys(obj).forEach(function (k) { fields[k] = toValue(obj[k]); });
  fsFetch(FS + '/' + path, 'patch', { fields: fields });
}
function deleteDoc(path) { fsFetch(FS + '/' + path, 'delete'); }
function listDocIds(col) {
  var ids = [], token = '';
  do {
    var r = fsFetch(FS + '/' + col + '?pageSize=300&mask.fieldPaths=title' + (token ? '&pageToken=' + token : ''), 'get') || {};
    (r.documents || []).forEach(function (d) { ids.push(d.name.split('/').pop()); });
    token = r.nextPageToken || '';
  } while (token);
  return ids;
}

function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
