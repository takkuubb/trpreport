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
      currency TEXT DEFAULT 'JPY',
      airbnb_url TEXT DEFAULT '',
      image_url TEXT DEFAULT ''
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
      report_type TEXT NOT NULL CHECK(report_type IN ('summary','detail','funnel','pricing','trend','portfolio','stay')),
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(listing_id, year_month, report_type)
    );
    CREATE TABLE IF NOT EXISTS ai_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_type TEXT NOT NULL UNIQUE CHECK(report_type IN ('summary','detail','funnel','pricing','trend','portfolio','stay')),
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
    CREATE TABLE IF NOT EXISTS stay_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      confirmation_code TEXT NOT NULL,
      listing_id TEXT NOT NULL,
      year_month TEXT NOT NULL,
      payout_date TEXT,
      start_date TEXT,
      nights INTEGER DEFAULT 0,
      guest_name TEXT,
      nationality TEXT DEFAULT 'Unknown',
      adults INTEGER DEFAULT 0,
      children INTEGER DEFAULT 0,
      infants INTEGER DEFAULT 0,
      total_guests INTEGER DEFAULT 0,
      amount REAL DEFAULT 0,
      service_fee REAL DEFAULT 0,
      cleaning_fee REAL DEFAULT 0,
      total_revenue REAL DEFAULT 0,
      cleaning_outsource REAL DEFAULT 0,
      net_revenue REAL DEFAULT 0,
      mgmt_fee REAL DEFAULT 0,
      owner_revenue REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(confirmation_code, listing_id, payout_date)
    );
    CREATE INDEX IF NOT EXISTS idx_stay_listing ON stay_records(listing_id, year_month);
    CREATE INDEX IF NOT EXISTS idx_stay_month ON stay_records(year_month);
  `);
}

const SYSTEM_PROMPT = `あなたはAirbnb物件運営会社のデータアナリストです。運営データを分析し、簡潔なレポートを作成してください。
以下のルールを必ず守ってください：
- 「オーナー様」「お世話になっております」「ご報告いたします」等の挨拶や形式的な前文は一切不要。いきなり分析内容から始める
- 「【マンスリーレポート】」「【月次報告】」等の大見出しも不要
- 簡潔で読みやすいトーン。ですます調で書く
- データに基づく客観的な分析を行う
- 具体的な数値を引用して説明する
- 改善策は「運営側で検討・対応を進める」というスタンスで記述する
- オーナーに作業を丸投げしない`;

const DEFAULT_PROMPTS = {
  summary: `以下のデータを分析してください：\n- 月間予約額、稼働泊数、ADR、成約率の状況\n- 前年同月比での変化\n- 注目ポイントと運営側での対応方針\n提案や改善方針は断定的に書かず、「〜などの対策検討を進めます」「〜といった施策が考えられます」のように柔らかい表現にしてください。\n250文字程度で簡潔に。挨拶や見出しなしで分析内容から始める。`,
  funnel: `以下のデータを分析してください：\n- 閲覧→連絡→予約の各ステップの転換率\n- 離脱が大きいポイントの特定\n- 写真・タイトル・説明文の改善余地\n- 運営側で対応を進める具体的なアクション\n提案や改善方針は断定的に書かず、「〜などの対策検討を進めます」「〜といった施策が考えられます」のように柔らかい表現にしてください。\n250文字程度で簡潔に。挨拶や見出しなしで分析内容から始める。`,
  pricing: `以下のデータを分析してください：\n- ADRの水準と変動\n- 予約リードタイムの傾向\n- 価格設定の最適化に関する提案\n- 運営側で検討を進める料金調整案\n提案や改善方針は断定的に書かず、「〜などの対策検討を進めます」「〜といった施策が考えられます」のように柔らかい表現にしてください。\n250文字程度で簡潔に。挨拶や見出しなしで分析内容から始める。`,
  trend: `以下のデータを分析してください：\n- 主要指標の前年比トレンド\n- 改善傾向にある指標と悪化傾向にある指標\n- 競合環境の変化の可能性\n- 運営側で進める付加価値向上策\n提案や改善方針は断定的に書かず、「〜などの対策検討を進めます」「〜といった施策が考えられます」のように柔らかい表現にしてください。\n250文字程度で簡潔に。挨拶や見出しなしで分析内容から始める。`,
  detail: `以下の月別実績推移データを分析してください：\n- 各月の主要KPI（予約額・予約数・ADR・稼働泊数）の変動\n- 前年同月比で特に変化が大きい指標\n- 季節要因やトレンドの読み取り\n- 今後の運営で注力すべきポイント\n提案や改善方針は断定的に書かず、「〜などの対策検討を進めます」「〜といった施策が考えられます」のように柔らかい表現にしてください。\n250文字程度で簡潔に。挨拶や見出しなしで分析内容から始める。`,
  stay: `施設の宿泊実績データ（ゲスト国籍・人数構成・売上・清掃費・純売上・オーナー収益）を分析してください。\n以下の観点で分析してください：\n1. 国籍構成の特徴（インバウンド比率、主要国籍とその傾向）\n2. ゲスト人数の傾向（平均人数、ファミリー/カップル/グループの割合推定）\n3. 売上と収益性（泊単価、純売上率、オーナー収益率）\n4. 改善ポイントや注目すべき傾向\n改善提案は断定的に書かず、「〜などの対策検討を進めます」「〜といった施策が考えられます」のように柔らかく曖昧な表現にしてください。\n挨拶や見出しは不要です。分析内容から直接始めてください。ですます調で250文字程度にまとめてください。`,
  portfolio: `以下は全リスティングのポートフォリオ全体データです。\n分析してください：\n- 全体の売上・稼働状況と前月比・前年同月比の変動\n- エリア別の強み・弱み（稼ぎ頭と課題エリア）\n- 売上TOP物件と成長著しい物件の特徴\n- ADR・成約率から見る価格戦略の有効性\n- 前年比下落物件の原因仮説と運営側の対応方針\n- 来月以降の運営戦略の提言\n提案や改善方針は断定的に書かず、「〜などの対策検討を進めます」「〜といった施策が考えられます」のように柔らかい表現にしてください。\n500文字程度で簡潔に。挨拶や見出しなしで分析内容から始める。`,
};

function seedDefaults() {
  const cnt = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (cnt === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?,?,?,?)').run('admin', hash, '管理者', 'admin');
    console.log('Created default admin: admin / admin123');
  }
  // Seed prompts

  // Migrate ai_reports/ai_prompts CHECK constraints to include 'stay'
  try {
    db.prepare("INSERT INTO ai_reports (listing_id,year_month,report_type,content) VALUES('_chk','_chk','stay','_chk')").run();
    db.prepare("DELETE FROM ai_reports WHERE listing_id='_chk'").run();
  } catch(_) {
    // Need to recreate tables with updated CHECK
    db.exec(`
      CREATE TABLE ai_reports_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id TEXT NOT NULL,
        year_month TEXT NOT NULL,
        report_type TEXT NOT NULL CHECK(report_type IN ('summary','detail','funnel','pricing','trend','portfolio','stay')),
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(listing_id, year_month, report_type)
      );
      INSERT INTO ai_reports_new SELECT * FROM ai_reports;
      DROP TABLE ai_reports;
      ALTER TABLE ai_reports_new RENAME TO ai_reports;

      CREATE TABLE ai_prompts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_type TEXT NOT NULL UNIQUE CHECK(report_type IN ('summary','detail','funnel','pricing','trend','portfolio','stay')),
        system_prompt TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO ai_prompts_new SELECT * FROM ai_prompts;
      DROP TABLE ai_prompts;
      ALTER TABLE ai_prompts_new RENAME TO ai_prompts;
    `);
  }

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
function updateListing(lid, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (['nickname','title','area','airbnb_url','image_url'].includes(k)) { sets.push(`${k}=?`); vals.push(v); }
  }
  if (!sets.length) return;
  vals.push(lid);
  db.prepare(`UPDATE listings SET ${sets.join(',')} WHERE listing_id=?`).run(...vals);
}
function getListing(lid) { return db.prepare('SELECT * FROM listings WHERE listing_id=?').get(lid); }
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
  return db.prepare('SELECT md.*, l.title, l.nickname, l.area, l.image_url, l.airbnb_url FROM monthly_data md LEFT JOIN listings l ON md.listing_id=l.listing_id WHERE md.year_month=? ORDER BY md.revenue DESC').all(yearMonth);
}

function getPortfolioSummary() {
  const months = getAvailableMonths();
  const result = [];
  for (const ym of months) {
    const row = db.prepare(`SELECT
      ? as year_month,
      SUM(revenue) as total_revenue,
      SUM(booked_nights) as total_nights,
      SUM(reservations) as total_reservations,
      ROUND(SUM(revenue)*1.0/NULLIF(SUM(booked_nights),0),0) as avg_adr,
      COUNT(*) as listing_count,
      SUM(CASE WHEN booked_nights > 0 THEN 1 ELSE 0 END) as active_count
    FROM monthly_data WHERE year_month=?`).get(ym, ym);
    // Estimate YoY from individual listing revenue_yoy percentages
    const listings = db.prepare('SELECT revenue, revenue_yoy, booked_nights, booked_nights_yoy, reservations, reservations_yoy FROM monthly_data WHERE year_month=?').all(ym);
    let prevRev=0, prevNights=0, prevRes=0, hasRevYoy=0, hasNightYoy=0, hasResYoy=0;
    for (const l of listings) {
      if (l.revenue_yoy && l.revenue_yoy !== '-') {
        const p = parseFloat(l.revenue_yoy.replace("'",""));
        if (!isNaN(p)) { prevRev += l.revenue / (1 + p/100); hasRevYoy++; }
      }
      if (l.booked_nights_yoy && l.booked_nights_yoy !== '-') {
        const p = parseFloat(l.booked_nights_yoy.replace("'",""));
        if (!isNaN(p)) { prevNights += l.booked_nights / (1 + p/100); hasNightYoy++; }
      }
      if (l.reservations_yoy && l.reservations_yoy !== '-') {
        const p = parseFloat(l.reservations_yoy.replace("'",""));
        if (!isNaN(p)) { prevRes += l.reservations / (1 + p/100); hasResYoy++; }
      }
    }
    row.yoy_revenue = hasRevYoy > 0 ? Math.round(prevRev) : null;
    row.yoy_nights = hasNightYoy > 0 ? Math.round(prevNights) : null;
    row.yoy_reservations = hasResYoy > 0 ? Math.round(prevRes) : null;
    result.push(row);
  }
  return result;
}

function getAreaSummary(yearMonth) {
  return db.prepare(`SELECT
    COALESCE(l.area, 'Other') as area,
    COUNT(*) as listing_count,
    SUM(m.revenue) as total_revenue,
    SUM(m.booked_nights) as total_nights,
    SUM(m.reservations) as total_reservations,
    ROUND(SUM(m.revenue)*1.0/NULLIF(SUM(m.booked_nights),0),0) as avg_adr,
    SUM(CASE WHEN m.booked_nights > 0 THEN 1 ELSE 0 END) as active_count
  FROM monthly_data m
  LEFT JOIN listings l ON m.listing_id=l.listing_id
  WHERE m.year_month=?
  GROUP BY COALESCE(l.area, 'Other')
  ORDER BY total_revenue DESC`).all(yearMonth);
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
      adr: pFloat(cols[11]), adr_yoy: calcAdrYoy(pFloat(cols[7]), pStr(cols[8]), pInt(cols[9]), pStr(cols[10])),
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
// Airbnb CSV col12 (ADR YoY) is unreliable (not per-listing, appears to be a portfolio-wide benchmark).
// Compute true per-listing ADR YoY from revenue/nights and their individual YoY percentages.
function calcAdrYoy(curRev, revYoyStr, curNights, nightsYoyStr) {
  if (!curRev || !curNights) return '-';
  const revYoy = parseFloat((revYoyStr || '').replace(/[%,'"]/g, ''));
  const nightsYoy = parseFloat((nightsYoyStr || '').replace(/[%,'"]/g, ''));
  if (isNaN(revYoy) || isNaN(nightsYoy)) return '-';
  if (revYoy === -100 || nightsYoy === -100) return '-';
  const prevRev = curRev / (1 + revYoy / 100);
  const prevNights = curNights / (1 + nightsYoy / 100);
  if (prevNights <= 0) return '-';
  const prevAdr = prevRev / prevNights;
  const curAdr = curRev / curNights;
  const yoyPct = ((curAdr - prevAdr) / prevAdr * 100).toFixed(2);
  return yoyPct + '%';
}


// Stay Records
function importStayRecords(records, yearMonth) {
  const ins = db.prepare(`INSERT OR REPLACE INTO stay_records
    (confirmation_code, listing_id, year_month, payout_date, start_date, nights,
     guest_name, nationality, adults, children, infants, total_guests,
     amount, service_fee, cleaning_fee, total_revenue,
     cleaning_outsource, net_revenue, mgmt_fee, owner_revenue)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let count = 0;
  db.transaction(() => {
    for (const r of records) {
      ins.run(
        r.confirmation_code, r.listing_id, yearMonth,
        r.payout_date||r.date||'', r.start_date||'', r.nights||0,
        r.guest_name||'', r.nationality||'Unknown',
        r.adults||0, r.children||0, r.infants||0, r.total_guests||0,
        r.amount||0, r.service_fee||0, r.cleaning_fee||0, r.total_revenue||0,
        r.cleaning_outsource||0, r.net_revenue||0, r.mgmt_fee||0, r.owner_revenue||0
      );
      count++;
    }
  })();
  return count;
}

// Helper: build listing ID filter for owner-scoped queries
function listingFilter(listingIds, prefix='') {
  if (!listingIds || !listingIds.length) return { clause: '', params: [] };
  const col = prefix ? prefix + '.listing_id' : 'listing_id';
  const ph = listingIds.map(()=>'?').join(',');
  return { clause: ` AND ${col} IN (${ph})`, params: listingIds };
}

function getStayRecordsByListing(listingId, yearMonth) {
  return db.prepare('SELECT * FROM stay_records WHERE listing_id=? AND year_month=? ORDER BY start_date').all(listingId, yearMonth);
}
function getStayRecordsByMonth(yearMonth) {
  return db.prepare(`SELECT sr.*, l.nickname, l.title, l.area, l.image_url FROM stay_records sr
    LEFT JOIN listings l ON sr.listing_id=l.listing_id WHERE sr.year_month=? ORDER BY sr.listing_id, sr.start_date`).all(yearMonth);
}
function getStaySummaryByListing(yearMonth, listingIds) {
  const f = listingFilter(listingIds, 'sr');
  return db.prepare(`SELECT sr.listing_id, l.nickname, l.title, l.area, l.image_url, l.airbnb_url,
    COUNT(*) as booking_count, SUM(sr.nights) as total_nights, SUM(sr.total_guests) as total_guests,
    SUM(sr.adults) as total_adults, SUM(sr.children) as total_children, SUM(sr.infants) as total_infants,
    SUM(sr.amount) as total_amount, SUM(sr.service_fee) as total_service_fee,
    SUM(sr.cleaning_fee) as total_cleaning_fee, SUM(sr.total_revenue) as total_total_revenue,
    SUM(sr.cleaning_outsource) as total_cleaning_outsource, SUM(sr.net_revenue) as total_net_revenue,
    SUM(sr.mgmt_fee) as total_mgmt_fee, SUM(sr.owner_revenue) as total_owner_revenue,
    ROUND(SUM(sr.amount)*1.0/NULLIF(SUM(sr.nights),0),0) as nightly_rate
    FROM stay_records sr LEFT JOIN listings l ON sr.listing_id=l.listing_id
    WHERE sr.year_month=?` + f.clause + ` GROUP BY sr.listing_id ORDER BY SUM(sr.amount) DESC`).all(yearMonth, ...f.params);
}
function getStayNationalitySummary(yearMonth, listingId, listingIds) {
  let w = 'WHERE year_month=?';
  let p = [yearMonth];
  if (listingId) { w += ' AND listing_id=?'; p.push(listingId); }
  const f = listingFilter(listingIds);
  w += f.clause; p.push(...f.params);
  return db.prepare(`SELECT nationality, COUNT(*) as cnt, SUM(total_guests) as guests,
    SUM(adults) as adults, SUM(children) as children, SUM(infants) as infants
    FROM stay_records ${w} GROUP BY nationality ORDER BY cnt DESC`).all(...p);
}
function getStayMonths(listingIds) {
  const f = listingFilter(listingIds);
  return db.prepare('SELECT DISTINCT year_month FROM stay_records WHERE 1=1' + f.clause + ' ORDER BY year_month DESC').all(...f.params).map(r=>r.year_month);
}
function getStayOverall(yearMonth, listingIds) {
  const f = listingFilter(listingIds);
  return db.prepare(`SELECT COUNT(*) as booking_count, COUNT(DISTINCT listing_id) as listing_count,
    SUM(nights) as total_nights, SUM(total_guests) as total_guests,
    SUM(adults) as total_adults, SUM(children) as total_children, SUM(infants) as total_infants,
    SUM(amount) as total_amount, SUM(service_fee) as total_service_fee,
    SUM(cleaning_fee) as total_cleaning_fee, SUM(total_revenue) as total_total_revenue,
    SUM(cleaning_outsource) as total_cleaning_outsource, SUM(net_revenue) as total_net_revenue,
    SUM(mgmt_fee) as total_mgmt_fee, SUM(owner_revenue) as total_owner_revenue,
    ROUND(SUM(amount)*1.0/NULLIF(SUM(nights),0),0) as avg_nightly_rate,
    ROUND(SUM(total_guests)*1.0/COUNT(*),1) as avg_guests_per_booking
    FROM stay_records WHERE year_month=?` + f.clause).get(yearMonth, ...f.params);
}


function getStayNatGroupByListing(yearMonth, listingIds) {
  const f = listingFilter(listingIds);
  return db.prepare(`SELECT listing_id, nationality, COUNT(*) as cnt
    FROM stay_records WHERE year_month=?` + f.clause + `
    GROUP BY listing_id, nationality ORDER BY listing_id, cnt DESC`).all(yearMonth, ...f.params);
}


// Parse and import stay (payout) CSV — supports regular (21-col) and tax (17-col)
function importStayCSV(content, yearMonth, userId, filename) {
  if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) throw new Error('年月をYYYY-MM形式で指定してください');
  if (content.charCodeAt(0) === 0xFEFF) content = content.substring(1);
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('データ行がありません');

  const header = lines[0];
  const isTax = header.includes('管理費') && !header.includes('入金予定日');

  const allListings = listListings();
  const lMap = {};
  for (const l of allListings) {
    if (l.nickname) lMap[l.nickname.trim()] = l.listing_id;
    if (l.title) lMap[l.title.trim()] = l.listing_id;
  }
  const SHORT = {'空(D)':'46054881','咲(C)':'46054250','風(B-1)':'46041421','彩(B-2)':'46040642','夢(E-1)':'46094651','月(E-2)':'46095229','星(A-2)':'45999954','音(A-1)':'48020055','AA Villa':'aa_villa_karuizawa'};
  const KEYWORD = {'蓮沼':'25759905','一宮海岸':'1580859822145228367'};

  function findLid(name) {
    if (!name) return null;
    name = name.trim();
    if (lMap[name]) return lMap[name];
    for (const [k,v] of Object.entries(SHORT)) { if (name.includes(k)) return v; }
    for (const [k,v] of Object.entries(lMap)) { if (k.length > 5 && name.includes(k)) return v; }
    for (const [k,v] of Object.entries(lMap)) { if (k.length > 5 && k.includes(name)) return v; }
    for (const [k,v] of Object.entries(KEYWORD)) { if (name.includes(k)) return v; }
    return null;
  }
  function pDate(d) {
    const m = (d||'').trim().match(/(\d{2})\/(\d{2})\/(\d{4})/);
    return m ? `${m[3]}-${m[1]}-${m[2]}` : '';
  }

  let imported = 0, skipped = 0, adjCount = 0;
  const unmatchedSet = new Set();

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 10) continue;

    let kind, date, confCode, startDate, nights, guest, listingName, detail, amount, serviceFee, cleaningFee, totalRevenue;

    if (isTax) {
      kind = (cols[1]||'').trim();
      if (kind === 'Pass Through Tot' || !kind) continue;
      date = pDate(cols[0]); confCode = (cols[2]||'').trim();
      startDate = pDate(cols[3]); nights = parseInt(cols[4]) || 0;
      guest = (cols[5]||'').trim(); listingName = (cols[6]||'').trim();
      detail = (cols[7]||'').trim();
      amount = parseFloat((cols[10]||'').replace(/,/g,'')) || 0;
      serviceFee = parseFloat((cols[12]||'').replace(/,/g,'')) || 0;
      cleaningFee = parseFloat((cols[13]||'').replace(/,/g,'')) || 0;
      totalRevenue = parseFloat((cols[14]||'').replace(/,/g,'')) || 0;
    } else {
      kind = (cols[2]||'').trim();
      if (kind === 'Payout' || !kind) continue;
      date = pDate(cols[0]); confCode = (cols[3]||'').trim();
      startDate = pDate(cols[5]); nights = parseInt(cols[7]) || 0;
      guest = (cols[8]||'').trim(); listingName = (cols[9]||'').trim();
      detail = (cols[10]||'').trim();
      amount = parseFloat((cols[13]||'').replace(/,/g,'')) || 0;
      serviceFee = parseFloat((cols[15]||'').replace(/,/g,'')) || 0;
      cleaningFee = parseFloat((cols[17]||'').replace(/,/g,'')) || 0;
      totalRevenue = parseFloat((cols[18]||'').replace(/,/g,'')) || 0;
    }

    const lid = findLid(listingName);
    if (!lid) { unmatchedSet.add(listingName); skipped++; continue; }

    const isAdj = (kind === '調整金' || kind === '解決の受取金');
    const code = isAdj ? `ADJ-${confCode}-${date}` : confCode;
    const guestName = isAdj ? `${guest} (${kind})` : guest;
    const netRev = isAdj ? amount : (amount - cleaningFee);
    const mgmtFee = Math.round(netRev * 0.20);
    const ownerRev = netRev - mgmtFee;

    db.prepare(`INSERT OR REPLACE INTO stay_records
      (confirmation_code, listing_id, year_month, payout_date, start_date, nights,
       guest_name, nationality, adults, children, infants, total_guests,
       amount, service_fee, cleaning_fee, total_revenue,
       cleaning_outsource, net_revenue, mgmt_fee, owner_revenue)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(code, lid, yearMonth, date, startDate, isAdj ? 0 : nights,
      guestName, 'Unknown', 0, 0, 0, 0,
      amount, isAdj ? 0 : serviceFee, isAdj ? 0 : cleaningFee, totalRevenue,
      0, netRev, mgmtFee, ownerRev);

    imported++;
    if (isAdj) adjCount++;
  }

  logUpload(filename || 'stay_upload.csv', yearMonth, imported, userId);
  return { imported, adjustments: adjCount, skipped, yearMonth, format: isTax ? '税フォーマット(17列)' : '通常フォーマット(21列)', unmatched: [...unmatchedSet] };
}

module.exports = {
  getDb, authenticate, getUser,
  getPasskeysByUser, getPasskeyByCred, savePasskey, updatePasskeyCounter, deletePasskey,
  listUsers, createUser, updateUser, deleteUser,
  getUserListings, setUserListings, listListings, upsertListing, updateListing, getListing,
  upsertMonthlyData, getMonthlyData, getMonthlyDataRange, getAvailableMonths, getMonthlyDataByMonth, getPortfolioSummary, getAreaSummary,
  getAiReport, saveAiReport, clearAiReports,
  getPrompt, listPrompts, updatePrompt,
  logUpload, listUploads, importCSV, importStayCSV,
  SYSTEM_PROMPT, DEFAULT_PROMPTS,
  importStayRecords, getStayRecordsByListing, getStayRecordsByMonth,
  getStaySummaryByListing, getStayNationalitySummary, getStayNatGroupByListing, getStayMonths, getStayOverall
};
