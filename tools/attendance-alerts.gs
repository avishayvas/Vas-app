/**
 * VAS — התרעות נוכחות במייל
 * רץ אוטומטית בשרתי גוגל (Google Apps Script), בחינם, גם כשאף טלפון לא פתוח.
 *  08:30  — מי שלא סימן "התחלת יום עבודה" מקבל מייל
 *  18:00  — מי שהתחיל יום ועוד לא סימן "סיום" מקבל תזכורת (בלי התרעה — אולי עדיין עובד)
 *  למחרת ב-08:30 — יום שנשאר פתוח בלי "סיום" נספר כהתרעה על יציאה
 *  כל 3 התרעות (ב-30 יום) — מייל אדום לעובד, עם העתק להנהלה
 * ימים: ראשון–חמישי. עובד שסומן "פטור היום" באפליקציה לא מקבל התרעה.
 *
 * התקנה: להדביק את הקובץ ב- script.google.com (מחשבון הגוגל שמחזיק את פרויקט ה-Firebase),
 * להריץ פעם אחת את הפונקציה setup ולאשר הרשאות. זהו.
 */
const PROJECT = 'vas-schedule';
const MANAGERS = ['avishay@s-vsecurity.com', 'office@s-vsecurity.com'];
const NOT_CHECKED = ['אבישי', 'הילה'];   // לא נבדקים (הנהלה ומשרד)
const APP_URL = 'https://avishayvas.github.io/Vas-app';
const WORK_DAYS = [0, 1, 2, 3, 4];   // ראשון=0 … חמישי=4
const STRIKE_WINDOW_DAYS = 30;
const STRIKES_TO_ESCALATE = 3;
const TZ = 'Asia/Jerusalem';

/* ---------- התקנה ---------- */
function setup(){
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('morningCheck').timeBased().atHour(8).nearMinute(30).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('eveningCheck').timeBased().atHour(18).nearMinute(0).everyDays(1).inTimezone(TZ).create();
  const team = loadTeam();
  Logger.log('הותקן. עובדים שייבדקו: ' + team.map(m => m.name + ' <' + m.email + '>').join(', '));
}

/* ---------- בדיקות ---------- */
function morningCheck(){ run('in'); }
function eveningCheck(){ run('out'); }
/* לבדיקה ידנית בלי לשלוח מיילים */
function dryRunMorning(){ run('in', true); }
function dryRunEvening(){ run('out', true); }

function run(kind, dry){
  const now = new Date();
  const dow = Number(Utilities.formatDate(now, TZ, 'u')) % 7;   // u: 1=שני … 7=ראשון
  if (WORK_DAYS.indexOf(dow) < 0){ Logger.log('לא יום עבודה'); return; }
  const day = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
  const team = loadTeam();
  const all = loadCheckins();
  const alerts = loadAlerts();
  alerts.sent = alerts.sent || {}; alerts.strikes = alerts.strikes || {}; alerts.red = alerts.red || {}; alerts.exempt = alerts.exempt || {};
  let changed = false;
  const prev = prevWorkDay(day);

  team.forEach(m => {
    const ofDay = d => all.filter(c => c.by === m.name && c.d === d).sort((a,b) => String(a.t).localeCompare(String(b.t)));
    const todays = ofDay(day), last = todays[todays.length - 1];
    if (kind === 'out'){
      // תזכורת בלבד — לא נספרת
      if ((alerts.exempt[day] || {})[m.name] || !last || last.type !== 'in') return;
      const key = day + '|remind|' + m.name;
      if (alerts.sent[key]) return;
      Logger.log((dry ? '[בדיקה] ' : '') + m.name + ' — תזכורת סיום יום');
      if (dry) return;
      sendReminder(m); alerts.sent[key] = true; changed = true;
      return;
    }
    const misses = [];
    if (!(alerts.exempt[day] || {})[m.name] && !todays.some(c => c.type === 'in')) misses.push({ d: day, type: 'in' });
    const p = ofDay(prev), pl = p[p.length - 1];
    if (prev && !(alerts.exempt[prev] || {})[m.name] && pl && pl.type === 'in') misses.push({ d: prev, type: 'out' });
    misses.forEach(x => {
      const key = x.d + '|' + x.type + '|' + m.name;
      if (alerts.sent[key]) return;
      const list = (alerts.strikes[m.name] || []).filter(s => daysBetween(s.d, day) < STRIKE_WINDOW_DAYS);
      list.push({ d: x.d, type: x.type });
      const n = list.length, red = n >= STRIKES_TO_ESCALATE;
      Logger.log((dry ? '[בדיקה] ' : '') + m.name + ' — ' + (x.type === 'in' ? 'לא סימן כניסה' : 'לא סימן יציאה ב-' + x.d) + ' · התרעה ' + n + (red ? ' 🔴' : ''));
      if (dry) return;
      sendMail(m, x.type, n, red);
      alerts.strikes[m.name] = list; alerts.sent[key] = true;
      if (red) alerts.red[m.name] = { d: x.d, n: n };
      changed = true;
    });
  });

  Object.keys(alerts.sent).forEach(k => { if (daysBetween(k.split('|')[0], day) > 40) delete alerts.sent[k]; });
  Object.keys(alerts.exempt).forEach(k => { if (daysBetween(k, day) > 40) delete alerts.exempt[k]; });
  if (changed){ alerts.updated = new Date().toISOString(); saveAlerts(alerts); }
}
function prevWorkDay(day){
  for (let i = 1; i <= 7; i++){
    const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - i);
    if (WORK_DAYS.indexOf(d.getUTCDay()) >= 0) return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
  }
  return '';
}
function sendReminder(m){
  const html = wrap('#3B6EA5', `<h2 style="margin:0 0 10px">שלום ${esc(m.name)},</h2>
    <p>יום העבודה שלך עדיין פתוח באפליקציה. כשמסיימים — לוחצים <b>"⏹ סיום יום עבודה"</b>.</p>
    <p style="color:#555B69">יום שנשאר פתוח עד מחר בבוקר נספר כהתרעה על אי-דיווח יציאה.</p>
    <p><a href="${APP_URL}" style="display:inline-block;background:#1B1F2A;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700">פתיחת האפליקציה</a></p>`);
  MailApp.sendEmail({ to: m.email, subject: 'VAS · תזכורת: לסמן סיום יום עבודה', htmlBody: html, name: 'VAS Security', replyTo: MANAGERS[1] });
}

/* ---------- מיילים ---------- */
function sendMail(m, missing, n, red){
  const what = missing === 'in' ? 'כניסה לעבודה' : 'יציאה מהעבודה';
  const btn = missing === 'in' ? '▶️ התחלת יום עבודה' : '⏹ סיום יום עבודה';
  let subject, html;
  if (!red){
    subject = 'VAS · לא דווחה ' + what + (missing === 'in' ? ' היום' : ' ביום העבודה הקודם');
    html = wrap('#C9962E', `
      <h2 style="margin:0 0 10px">שלום ${esc(m.name)},</h2>
      <p>${missing === 'in' ? 'עד השעה <b>08:30</b> לא סומנה באפליקציה <b>כניסה לעבודה</b>.' : 'יום העבודה הקודם נשאר פתוח — לא סומנה באפליקציה <b>יציאה מהעבודה</b>.'}</p>
      <p>אם זו טעות או ששכחת — נכנסים עכשיו לאפליקציה ולוחצים <b>"${btn}"</b>.</p>
      <p style="background:#FBF2DC;border-radius:8px;padding:10px 12px;font-weight:700">זו התרעה ${n} מתוך ${STRIKES_TO_ESCALATE}. בהתרעה ה-${STRIKES_TO_ESCALATE} הנושא מועבר להנהלה.</p>
      <p><a href="${APP_URL}" style="display:inline-block;background:#1B1F2A;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700">פתיחת האפליקציה</a></p>`);
    MailApp.sendEmail({ to: m.email, subject: subject, htmlBody: html, name: 'VAS Security', replyTo: MANAGERS[1] });
  } else {
    subject = '🔴 חריגה בדיווח נוכחות — ' + m.name + ' — הועבר להנהלה';
    html = wrap('#D64545', `
      <h2 style="margin:0 0 10px;color:#B23A3A">🔴 חריגה בדיווח נוכחות</h2>
      <p><b>${esc(m.name)}</b>, זו ההתרעה ה-${n} ב-${STRIKE_WINDOW_DAYS} הימים האחרונים על אי-דיווח כניסה/יציאה.</p>
      <p style="background:#FDECEC;border:1.5px solid #D64545;border-radius:8px;padding:12px;font-weight:800;color:#B23A3A">זהו מצב חריג ולא תקין. הנושא הועבר להנהלה לטיפול.</p>
      <p>מעכשיו יש לסמן בכל יום עבודה <b>"התחלת יום עבודה"</b> עד 08:30 ו<b>"סיום יום עבודה"</b> בסוף היום.</p>
      <p><a href="${APP_URL}" style="display:inline-block;background:#1B1F2A;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700">פתיחת האפליקציה</a></p>`);
    MailApp.sendEmail({ to: m.email, cc: MANAGERS.join(','), subject: subject, htmlBody: html, name: 'VAS Security', replyTo: MANAGERS[1] });
  }
}
function wrap(color, inner){
  return `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;color:#1B1F2A;max-width:560px;margin:auto;border-top:6px solid ${color};background:#F5F3ED;padding:22px;border-radius:12px;line-height:1.6">
    <div style="font-size:22px;font-weight:900;color:#C9962E;letter-spacing:1px;margin-bottom:14px">VAS <span style="color:#1B1F2A;font-weight:300;font-size:14px;letter-spacing:3px">SECURITY</span></div>
    ${inner}
    <div style="font-size:11px;color:#8A8F9C;margin-top:18px">הודעה אוטומטית ממערכת הנוכחות של VAS Security Technology LTD</div></div>`;
}
function esc(s){ return String(s || '').replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c])); }

/* ---------- נתונים מ-Firestore ---------- */
function fsUrl(path){ return 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/' + path; }
function fsGet(path, fields){
  const q = fields ? '?' + fields.map(f => 'mask.fieldPaths=' + f).join('&') : '';
  const r = UrlFetchApp.fetch(fsUrl(path) + q, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (r.getResponseCode() === 404) return null;
  if (r.getResponseCode() !== 200) throw new Error('Firestore ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 300));
  return decodeFields(JSON.parse(r.getContentText()).fields || {});
}
function decode(v){
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  return null;
}
function decodeFields(f){ const o = {}; Object.keys(f).forEach(k => o[k] = decode(f[k])); return o; }

function loadTeam(){
  const d = fsGet('vas/punch', ['team']) || {};
  return (d.team || []).filter(m => m && m.email && m.name && NOT_CHECKED.indexOf(m.name) < 0 && MANAGERS.indexOf(String(m.email).trim().toLowerCase()) < 0 && m.kind !== 'קבלן' && !/קבלן/.test(m.role || ''))
    .map(m => ({ name: m.name, email: String(m.email).trim() }));
}
function loadCheckins(){
  const a = (fsGet('vas/checkins') || {}).list || [];
  const b = (fsGet('vas/punch', ['checkins']) || {}).checkins || [];
  return a.concat(b).filter(Boolean);
}
function loadAlerts(){
  const d = fsGet('vas/alerts');
  try { return d && d.data ? JSON.parse(d.data) : {}; } catch(e){ return {}; }
}
function saveAlerts(obj){
  const body = { fields: { data: { stringValue: JSON.stringify(obj) } } };
  const r = UrlFetchApp.fetch(fsUrl('vas/alerts') + '?updateMask.fieldPaths=data', {
    method: 'patch', contentType: 'application/json', payload: JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('שמירה נכשלה ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 300));
}
function daysBetween(a, b){ return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000); }
