const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

let db;
function getDb() {
  if (db) return db;
  db = new Database(path.join(__dirname, '..', 'trpreport.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate();
  seedDefaults();
  return db;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','owner')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      device_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS user_listings (
      user_id INTEGER NOT NULL REFERENCES users(id),
      listing_id TEXT NOT NULL,
      PRIMARY KEY (user_id, listing_id)
    );
    CREATE TABLE IF NOT EXISTS listings (
      listing_id TEXT PRIMARY KEY,
      title TEXT,
      nickname TEXT,
      area TEXT,
      currency TEXT DEFAULT 'JPY'
    );
    CREATE TABLE IF NOT EXISTS monthly_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id TEXT NOT NULL,
      year_month TEXT NOT NULL,
      reservations INTEGER DEFAULT 0,
      reservations_yoy TEXT,
      revenue REAL DEFAULT 0,
      revenue_yoy TEXT,
      booked_nights INTEGER DEFAULT 0,
      booked_nights_yoy TEXT,
      adr REAL DEFAULT 0,
      adr_yoy TEXT,
      avg_stay_days REAL DEFAULT 0,
      avg_stay_days_yoy TEXT,
      avg_lead_time REAL DEFAULT 0,
      avg_lead_time_yoy TEXT,
      contact_rate REAL DEFAULT 0,
      contact_rate_yoy TEXT,
      booking_rate REAL DEFAULT 0,
      booking_rate_yoy TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(listing_id, year_month)
    );
    CREATE TABLE IF NOT EXISTS ai_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id TEXT NOT NULL,
      year_month TEXT NOT NULL,
      report_type TEXT NOT NULL CHECK(report_type IN ('summary','funnel','pricing','trend')),
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(listing_id, year_month, report_type)
    );
    CREATE TABLE IF NOT EXISTS ai_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_type TEXT NOT NULL UNIQUE CHECK(report_type IN ('summary','funnel','pricing','trend')),
      system_prompt TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS csv_uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      year_month TEXT NOT NULL,
      rows_imported INTEGER DEFAULT 0,
      uploaded_by INTEGER REFERENCES users(id),
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

const SYSTEM_PROMPT = `あなたはAirbnb物件運営会社のデータアナリストです。運営データを分析し、簡潔なレポートを作成してください。
以下のルールを必ず守ってください：
- 「オーナー様」「お世話になっております」「ご報告いたします」等の挨拶や形式的な前文は一切不要。いきなり分析内容から始める
- 「【マンスリーレポート】」「【月次報告】」等の大見出しも不要
- 簡潔で読みやすいトーン。童体で書く
- データに基づく客観的な分析を行う
- 具体的な数値を引用して説明する
- 改善策は「運営側で検討・対応を進める」というスタンスで記述する
- オーナーに作業を丸投げしない`;

const DEFAULT_PROMPTS = {
  summary: `以下のデータを分析してください：\n- 月間予約額、稼働泊数、ADR、成約率の状況\n- 前年同月比での変化\n- 注目ポイントと運営側での対応方針\n250文字程度で簡潔に。挨拶や見出しなしで分析内容から始める。`,
  funnel: `以下のデータを分析してください：\n- 閲覧→連絡→予約の各ステップの転換率\n- 離脱が大きいポイントの特定\n- 写真・タイトル・説明文の改善余地\n- 運営側で対応を進める具体的なアクション\n250文字程度で簡潔に。挨拶や見出しなしで分析内容から始める。`,
  pricing: `以下のデータを分析してください：\n- ADRの水準と変動\n- 予約リードタイムの傾向\n- 価格設定の最適化に関する提案\n- 運営側で検討を進める料金調整案\n250文字程度で簡潔に。挨拶や見出しなしで分析内容から始める。`,
  trend: `以下のデータを分析してください：\n- 主要指標の前年比トレンド\n- 改善傾向にある指標と悪化傾向にある指標\n- 競合環境の変化の可能性\n- 運営側で進める付加価値向上策\n250文字程度で簡潔に。挨拶や見出しなしで分析内容から始める。`
};

function seedDefaults() {
  const cnt = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (cnt === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?,?,?,?)').run('admin', hash, '管理者', 'admin');
    console.log('Created default admin: admin / admin123');
  }
  // Seed prompts
  const ins = db.prepare('INSERT OR IGNORE INTO ai_prompts (report_type, system_prompt) VALUES (?,?)');
  for (const [type, prompt] of Object.entries(DEFAULT_PROMPTS)) ins.run(type, prompt);
}

// Auth
function authenticate(username, password) {
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || !u.password_hash) return null;
  if (!bcrypt.compareSync(password, u.password_hash)) return null;
  return { id: u.id, username: u.username, display_name: u.display_name, role: u.role };
}

// Passkeys
function getPasskeysByUser(uid) { return db.prepare('SELECT * FROM passkeys WHERE user_id=?').all(uid); }
function getPasskeyByCred(cid) { return db.prepare('SELECT * FROM passkeys WHERE id=?').get(cid); }
function savePasskey(uid, cid, pubkey, counter, deviceName) {
  db.prepare('INSERT INTO passkeys (id, user_id, public_key, counter, device_name) VALUES (?,?,?,?,?)').run(cid, uid, pubkey, counter, deviceName || null);
}
function updatePasskeyCounter(cid, cnt) { db.prepare('UPDATE passkeys SET counter=? WHERE id=?').run(cnt, cid); }
function deletePasskey(cid, uid) { db.prepare('DELETE FROM passkeys WHERE id=? AND user_id=?').run(cid, uid); }
function getUser(id) { return db.prepare('SELECT * FROM users WHERE id=?').get(id); }

// Users CRUD
function listUsers() { return db.prepare('SELECT id, username, display_name, role, created_at FROM users ORDER BY id').all(); }
function createUser(username, password, displayName, role) {
  const hash = bcrypt.hashSync(password, 10);
  return db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?,?,?,?)').run(username, hash, displayName, role);
}
function updateUser(id, data) {
  if (data.password) {
    const hash = bcrypt.hashSync(data.password, 10);
    db.prepare('UPDATE users SET username=?, password_hash=?, display_name=?, role=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(data.username, hash, data.display_name, data.role, id);
  } else {
    db.prepare('UPDATE users SET username=?, display_name=?, role=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(data.username, data.display_name, data.role, id);
  }
}
function deleteUser(id) {
  db.prepare('DELETE FROM user_listings WHERE user_id=?').run(id);
  db.prepare('DELETE FROM passkeys WHERE user_id=?').run(id);
  db.prepare('DELETE FROM users WHERE id=?').run(id);
}

// User-Listing mapping
function getUserListings(uid) {
  return db.prepare(`SELECT l.* FROM listings l JOIN user_listings ul ON l.listing_id=ul.listing_id WHERE ul.user_id=? ORDER BY l.title`).all(uid);
}
function setUserListings(uid, listingIds) {
  const del = db.prepare('DELETE FROM user_listings WHERE user_id=?');
  const ins = db.prepare('INSERT INTO user_listings (user_id, listing_id) VALUES (?,?)');
  db.transaction(() => {
    del.run(uid);
    for (const lid of listingIds) ins.run(uid, lid);
  })();
}

// Listings
function listListings() { return db.prepare('SELECT * FROM listings ORDER BY title').all(); }
function upsertListing(lid, title, nickname, area, currency) {
  db.prepare('INSERT INTO listings (listing_id, title, nickname, area, currency) VALUES (?,?,?,?,?) ON CONFLICT(listing_id) DO UPDATE SET title=excluded.title, nickname=CASE WHEN excluded.nickname!=\'\' THEN excluded.nickname ELSE listings.nickname END, area=CASE WHEN excluded.area!=\'\' THEN excluded.area ELSE listings.area END, currency=excluded.currency').run(lid, title, nickname, area, currency);
}

// Monthly Data
function upsertMonthlyData(d) {
  db.prepare(`INSERT INTO monthly_data (listing_id, year_month, reservations, reservations_yoy, revenue, revenue_yoy, booked_nights, booked_nights_yoy, adr, adr_yoy, avg_stay_days, avg_stay_days_yoy, avg_lead_time, avg_lead_time_yoy, contact_rate, contact_rate_yoy, booking_rate, booking_rate_yoy)
    VALUES (@listing_id, @year_month, @reservations, @reservations_yoy, @revenue, @revenue_yoy, @booked_nights, @booked_nights_yoy, @adr, @adr_yoy, @avg_stay_days, @avg_stay_days_yoy, @avg_lead_time, @avg_lead_time_yoy, @contact_rate, @contact_rate_yoy, @booking_rate, @booking_rate_yoy)
    ON CONFLICT(listing_id, year_month) DO UPDATE SET
      reservations=excluded.reservations, reservations_yoy=excluded.reservations_yoy,
      revenue=excluded.revenue, revenue_yoy=excluded.revenue_yoy,
      booked_nights=excluded.booked_nights, booked_nights_yoy=excluded.booked_nights_yoy,
      adr=excluded.adr, adr_yoy=excluded.adr_yoy,
      avg_stay_days=excluded.avg_stay_days, avg_stay_days_yoy=excluded.avg_stay_days_yoy,
      avg_lead_time=excluded.avg_lead_time, avg_lead_time_yoy=excluded.avg_lead_time_yoy,
      contact_rate=excluded.contact_rate, contact_rate_yoy=excluded.contact_rate_yoy,
      booking_rate=excluded.booking_rate, booking_rate_yoy=excluded.booking_rate_yoy
  `).run(d);
}

function getMonthlyData(listingId, yearMonth) {
  return db.prepare('SELECT * FROM monthly_data WHERE listing_id=? AND year_month=?').get(listingId, yearMonth);
}
function getMonthlyDataRange(listingId) {
  return db.prepare('SELECT * FROM monthly_data WHERE listing_id=? ORDER BY year_month').all(listingId);
}
function getAvailableMonths() {
  return db.prepare('SELECT DISTINCT year_month FROM monthly_data ORDER BY year_month DESC').all().map(r => r.year_month);
}
function getMonthlyDataByMonth(yearMonth) {
  return db.prepare('SELECT md.*, l.title, l.nickname FROM monthly_data md LEFT JOIN listings l ON md.listing_id=l.listing_id WHERE md.year_month=? ORDER BY md.revenue DESC').all(yearMonth);
}

// AI Reports
function getAiReport(listingId, yearMonth, type) {
  return db.prepare('SELECT * FROM ai_reports WHERE listing_id=? AND year_month=? AND report_type=?').get(listingId, yearMonth, type);
}
function saveAiReport(listingId, yearMonth, type, content) {
  db.prepare('INSERT OR REPLACE INTO ai_reports (listing_id, year_month, report_type, content) VALUES (?,?,?,?)').run(listingId, yearMonth, type, content);
}
function clearAiReports(listingId, yearMonth) {
  if (listingId && yearMonth) db.prepare('DELETE FROM ai_reports WHERE listing_id=? AND year_month=?').run(listingId, yearMonth);
  else db.prepare('DELETE FROM ai_reports').run();
}

// AI Prompts
function getPrompt(type) { return db.prepare('SELECT * FROM ai_prompts WHERE report_type=?').get(type); }
function listPrompts() { return db.prepare('SELECT * FROM ai_prompts ORDER BY report_type').all(); }
function updatePrompt(type, text) { db.prepare('UPDATE ai_prompts SET system_prompt=?, updated_at=CURRENT_TIMESTAMP WHERE report_type=?').run(text, type); }

// CSV Uploads
function logUpload(filename, yearMonth, rows, userId) {
  db.prepare('INSERT INTO csv_uploads (filename, year_month, rows_imported, uploaded_by) VALUES (?,?,?,?)').run(filename, yearMonth, rows, userId);
}
function listUploads() {
  return db.prepare('SELECT c.*, u.display_name as uploader FROM csv_uploads c LEFT JOIN users u ON c.uploaded_by=u.id ORDER BY c.uploaded_at DESC LIMIT 50').all();
}

// CSV Import
function importCSV(content, yearMonth, userId, filename) {
  // Remove BOM
  if (content.charCodeAt(0) === 0xFEFF) content = content.substring(1);
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 3) throw new Error('データ行がありません');

  // Auto-detect year_month from line 1 if not provided
  if (!yearMonth) {
    const m = lines[0].match(/(\d{4})-(\d{2})-\d{2}から/);
    if (m) yearMonth = m[1] + '-' + m[2];
    else throw new Error('年月を自動検出できません');
  }

  // Parse header (line 2 = index 1)
  // Skip to data rows (line 3+)
  let imported = 0;
  for (let i = 2; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 5) continue;
    const lid = cols[0]?.replace(/"/g, '').trim();
    if (!lid) continue;
    const title = cols[1]?.replace(/"/g, '').trim() || '';
    const nickname = cols[2]?.replace(/"/g, '').trim() || '';
    const area = cols[3]?.replace(/"/g, '').trim() || '';
    const currency = cols[4]?.replace(/"/g, '').trim() || 'JPY';

    upsertListing(lid, title, nickname, area, currency);
    upsertMonthlyData({
      listing_id: lid, year_month: yearMonth,
      reservations: pInt(cols[5]), reservations_yoy: pStr(cols[6]),
      revenue: pFloat(cols[7]), revenue_yoy: pStr(cols[8]),
      booked_nights: pInt(cols[9]), booked_nights_yoy: pStr(cols[10]),
      adr: pFloat(cols[11]), adr_yoy: pStr(cols[12]),
      avg_stay_days: pFloat(cols[13]), avg_stay_days_yoy: pStr(cols[14]),
      avg_lead_time: pFloat(cols[15]), avg_lead_time_yoy: pStr(cols[16]),
      contact_rate: pFloat(cols[17]), contact_rate_yoy: pStr(cols[18]),
      booking_rate: pFloat(cols[19]), booking_rate_yoy: pStr(cols[20])
    });
    imported++;
  }
  logUpload(filename || 'upload.csv', yearMonth, imported, userId);
  return { imported, yearMonth };
}

function parseCSVLine(line) {
  const result = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
    else { if (c === '"') inQ = true; else if (c === ',') { result.push(cur); cur = ''; } else cur += c; }
  }
  result.push(cur);
  return result;
}

function pInt(v) { const n = parseInt((v || '').replace(/[",]/g, '')); return isNaN(n) ? 0 : n; }
function pFloat(v) { const n = parseFloat((v || '').replace(/[",]/g, '')); return isNaN(n) ? 0 : n; }
function pStr(v) { return (v || '').replace(/"/g, '').trim(); }

module.exports = {
  getDb, authenticate, getUser,
  getPasskeysByUser, getPasskeyByCred, savePasskey, updatePasskeyCounter, deletePasskey,
  listUsers, createUser, updateUser, deleteUser,
  getUserListings, setUserListings, listListings, upsertListing,
  upsertMonthlyData, getMonthlyData, getMonthlyDataRange, getAvailableMonths, getMonthlyDataByMonth,
  getAiReport, saveAiReport, clearAiReports,
  getPrompt, listPrompts, updatePrompt,
  logUpload, listUploads, importCSV,
  SYSTEM_PROMPT, DEFAULT_PROMPTS
};
