import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export interface CallRecord {
  id: number;
  stream_sid: string;
  caller_number: string;
  caller_name?: string;
  duration_seconds: number;
  full_transcript: string;
  summary: string;
  recording_url?: string;
  created_at: string;
}

export interface LeadRecord {
  id?: number;
  call_id?: number | null;
  caller_phone: string;
  caller_name: string;
  lead_quality?: string;
  config: string;
  intent: string;
  location: string;
  budget: string;
  timeline: string;
  visit_day: string;
  status: string;
  summary?: string;
  lead_email?: string;
  recording_url?: string;
  created_at?: string;
}

const isVercel = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DB_DIR = isVercel ? '/tmp/data' : path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DB_DIR)) {
  try {
    fs.mkdirSync(DB_DIR, { recursive: true });
  } catch { }
}

const DB_PATH = path.join(DB_DIR, 'voice_agent.db');

// If on Vercel and DB doesn't exist in /tmp yet, copy source DB
if (isVercel && !fs.existsSync(DB_PATH)) {
  const sourceDb = path.resolve(process.cwd(), 'data', 'voice_agent.db');
  if (fs.existsSync(sourceDb)) {
    try {
      fs.copyFileSync(sourceDb, DB_PATH);
    } catch (err) {
      console.warn('Could not copy source DB to /tmp:', err);
    }
  }
}

// In-memory fallback dataset in case native bindings fail in serverless
let memCalls: CallRecord[] = [];
let memLeads: LeadRecord[] = [];
let memLearnings: AgentLearning[] = [];

// Try to load seed data
try {
  const seedPath = path.resolve(process.cwd(), 'data', 'seed_data.json');
  if (fs.existsSync(seedPath)) {
    const raw = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    memCalls = raw.calls || [];
    memLeads = raw.leads || [];
    memLearnings = raw.learnings || [];
  }
} catch { }

let sqliteDb: Database.Database | null = null;
try {
  sqliteDb = new Database(DB_PATH);
  sqliteDb.pragma('journal_mode = WAL');
} catch (err) {
  console.warn('SQLite native init warning, fallback active:', err);
}

// Use a type-safe nullable export; callers guard with `if (!db)` checks
export const db: Database.Database | null = sqliteDb;

/** Throws a descriptive error if SQLite is unavailable — prevents silent null dereferences. */
function requireDb(): Database.Database {
  if (!sqliteDb) {
    throw new Error('SQLite database is unavailable (native binding failed to load).');
  }
  return sqliteDb;
}

export function initDatabase(): void {
  if (!sqliteDb) return;
  try {
    sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stream_sid TEXT,
      caller_number TEXT,
      duration_seconds INTEGER DEFAULT 0,
      full_transcript TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      recording_url TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id INTEGER,
      caller_phone TEXT NOT NULL,
      caller_name TEXT DEFAULT '',
      lead_quality TEXT DEFAULT 'Good Lead',
      config TEXT DEFAULT '',
      intent TEXT DEFAULT '',
      location TEXT DEFAULT '',
      budget TEXT DEFAULT '',
      timeline TEXT DEFAULT '',
      visit_day TEXT DEFAULT '',
      status TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      lead_email TEXT DEFAULT '',
      recording_url TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS agent_learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id INTEGER,
      learning_type TEXT DEFAULT 'insight',
      key_insight TEXT NOT NULL,
      caller_utterance TEXT DEFAULT '',
      best_response TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_calls_stream_sid ON calls(stream_sid);
    CREATE INDEX IF NOT EXISTS idx_leads_caller_phone ON leads(caller_phone);
    CREATE INDEX IF NOT EXISTS idx_learnings_call_id ON agent_learnings(call_id);
  `);

    // Additive migrations (idempotent — errors are expected on re-run and silently skipped)
    try {
      sqliteDb.exec("ALTER TABLE leads ADD COLUMN lead_quality TEXT DEFAULT 'Good Lead'");
    } catch { }
    try {
      sqliteDb.exec("ALTER TABLE leads ADD COLUMN lead_email TEXT DEFAULT ''");
    } catch { }
    try {
      sqliteDb.exec("ALTER TABLE calls ADD COLUMN recording_url TEXT DEFAULT ''");
    } catch { }
    try {
      sqliteDb.exec("ALTER TABLE leads ADD COLUMN recording_url TEXT DEFAULT ''");
    } catch { }
  } catch (err) {
    console.warn('initDatabase exec error:', err);
  }
}

// Initialize tables once on module load
initDatabase();

// Call operations
export function createCall(streamSid: string, callerNumber: string): number {
  const db = requireDb();
  const stmt = db.prepare(`
    INSERT INTO calls (stream_sid, caller_number, created_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `);
  const result = stmt.run(streamSid, callerNumber);
  return Number(result.lastInsertRowid);
}

export function updateCall(
  callId: number,
  durationSeconds: number,
  fullTranscript: string,
  summary: string,
  recordingUrl?: string
): void {
  const db = requireDb();
  if (recordingUrl) {
    const stmt = db.prepare(`
      UPDATE calls
      SET duration_seconds = ?, full_transcript = ?, summary = ?, recording_url = ?
      WHERE id = ?
    `);
    stmt.run(durationSeconds, fullTranscript, summary, recordingUrl, callId);
  } else {
    const stmt = db.prepare(`
      UPDATE calls
      SET duration_seconds = ?, full_transcript = ?, summary = ?
      WHERE id = ?
    `);
    stmt.run(durationSeconds, fullTranscript, summary, callId);
  }
}

export function updateLeadRecording(callId: number, recordingUrl: string): void {
  if (!sqliteDb || !callId || !recordingUrl) return;
  try {
    const stmt = sqliteDb.prepare(`
      UPDATE leads
      SET recording_url = ?
      WHERE call_id = ?
    `);
    stmt.run(recordingUrl, callId);
  } catch (err) {
    console.warn('[DB] Could not update lead recording_url:', err);
  }
}

export function getCalls(limit: number = 50): CallRecord[] {
  if (!sqliteDb) return memCalls.slice(0, limit);
  const stmt = sqliteDb.prepare(`
    SELECT c.*, COALESCE(l.caller_name, 'Inquiring Caller') as caller_name
    FROM calls c
    LEFT JOIN leads l ON l.call_id = c.id
    ORDER BY c.id DESC
    LIMIT ?
  `);
  return stmt.all(limit) as CallRecord[];
}

export function getCallById(id: number): CallRecord | undefined {
  if (!sqliteDb) return memCalls.find((c) => c.id === id);
  const stmt = sqliteDb.prepare('SELECT * FROM calls WHERE id = ?');
  return stmt.get(id) as CallRecord | undefined;
}

// Lead operations
export function insertLead(lead: LeadRecord): number {
  const db = requireDb();
  const quality = lead.lead_quality || (lead.status?.includes('Bad') || lead.status?.includes('Cold') ? 'Bad Lead' : 'Good Lead');
  const leadEmail = lead.lead_email || process.env.LEAD_EMAIL || '';
  const stmt = db.prepare(`
    INSERT INTO leads (
      call_id, caller_phone, caller_name, lead_quality, config, intent,
      location, budget, timeline, visit_day, status, summary, lead_email, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
  const result = stmt.run(
    lead.call_id ?? null,
    lead.caller_phone || '',
    lead.caller_name || '',
    quality,
    lead.config || '',
    lead.intent || '',
    lead.location || '',
    lead.budget || '',
    lead.timeline || '',
    lead.visit_day || '',
    lead.status || '',
    lead.summary || '',
    leadEmail
  );
  return Number(result.lastInsertRowid);
}

export function getLeads(limit: number = 50): LeadRecord[] {
  if (!sqliteDb) return memLeads.slice(0, limit);
  const stmt = sqliteDb.prepare(`
    SELECT * FROM leads
    ORDER BY id DESC
    LIMIT ?
  `);
  return stmt.all(limit) as LeadRecord[];
}

export interface LeadStats {
  totalCalls: number;
  totalLeads: number;
  goodLeads: number;
  badLeads: number;
  hotLeads: number;
  warmLeads: number;
  locations: Record<string, number>;
}

export function getLeadStats(): LeadStats {
  if (!sqliteDb) {
    return { totalCalls: memCalls.length, totalLeads: memLeads.length, goodLeads: 0, badLeads: 0, hotLeads: 0, warmLeads: 0, locations: {} };
  }
  const db = sqliteDb;
  const totalCalls = (db.prepare('SELECT count(*) as count FROM calls').get() as any)?.count || 0;
  const totalLeads = (db.prepare('SELECT count(*) as count FROM leads').get() as any)?.count || 0;
  const goodLeads = (db.prepare("SELECT count(*) as count FROM leads WHERE lead_quality = 'Good Lead' OR status LIKE '%Good%' OR status LIKE '%Hot%' OR status LIKE '%Warm%'").get() as any)?.count || 0;
  const badLeads = (db.prepare("SELECT count(*) as count FROM leads WHERE lead_quality = 'Bad Lead' OR status LIKE '%Bad%' OR status LIKE '%Cold%' OR status LIKE '%Unqualified%'").get() as any)?.count || 0;
  const hotLeads = (db.prepare("SELECT count(*) as count FROM leads WHERE status LIKE '%Hot%'").get() as any)?.count || 0;
  const warmLeads = (db.prepare("SELECT count(*) as count FROM leads WHERE status LIKE '%Warm%'").get() as any)?.count || 0;

  const locRows = db.prepare(`
    SELECT location, count(*) as count
    FROM leads
    WHERE location IS NOT NULL AND location != ''
    GROUP BY location
    ORDER BY count DESC
    LIMIT 6
  `).all() as { location: string; count: number }[];

  const locations: Record<string, number> = {};
  for (const row of locRows) {
    locations[row.location] = row.count;
  }

  return { totalCalls, totalLeads, goodLeads, badLeads, hotLeads, warmLeads, locations };
}

export function exportLeadsToCsv(): string {
  const leads = getLeads(1000);
  const headers = [
    'ID',
    'Call ID',
    'Timestamp',
    'Caller Phone',
    'Caller Name',
    'Configuration',
    'Intent',
    'Location',
    'Budget',
    'Timeline',
    'Site Visit Day',
    'Status',
    'Summary',
    'Registered Lead Email',
  ];

  const escapeCsv = (str: string | number | null | undefined): string => {
    if (str === null || str === undefined) return '""';
    const s = String(str).replace(/"/g, '""');
    return `"${s}"`;
  };

  const rows = leads.map((lead) => [
    escapeCsv(lead.id),
    escapeCsv(lead.call_id),
    escapeCsv(lead.created_at),
    escapeCsv(lead.caller_phone),
    escapeCsv(lead.caller_name),
    escapeCsv(lead.config),
    escapeCsv(lead.intent),
    escapeCsv(lead.location),
    escapeCsv(lead.budget),
    escapeCsv(lead.timeline),
    escapeCsv(lead.visit_day),
    escapeCsv(lead.status),
    escapeCsv(lead.summary),
    escapeCsv(lead.lead_email || process.env.LEAD_EMAIL || ''),
  ]);

  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
}

export interface AgentLearning {
  id?: number;
  call_id?: number | null;
  learning_type: string;
  key_insight: string;
  caller_utterance?: string;
  best_response?: string;
  created_at?: string;
}

export function saveAgentLearning(learning: AgentLearning): number {
  const db = requireDb();
  const stmt = db.prepare(`
    INSERT INTO agent_learnings (call_id, learning_type, key_insight, caller_utterance, best_response)
    VALUES (?, ?, ?, ?, ?)
  `);
  const res = stmt.run(
    learning.call_id || null,
    learning.learning_type,
    learning.key_insight,
    learning.caller_utterance || '',
    learning.best_response || ''
  );
  return Number(res.lastInsertRowid);
}

export function getRecentLearnings(limit: number = 8): AgentLearning[] {
  if (!sqliteDb) return memLearnings.slice(0, limit);
  const stmt = sqliteDb.prepare(`
    SELECT * FROM agent_learnings
    ORDER BY id DESC
    LIMIT ?
  `);
  return stmt.all(limit) as AgentLearning[];
}

export interface CallerMemoryContext {
  phoneNumber: string;
  isReturningCaller: boolean;
  totalPreviousCalls: number;
  lastCallDate?: string;
  lastCallSummary?: string;
  existingLead?: {
    callerName?: string;
    config?: string;
    budget?: string;
    intent?: string;
    location?: string;
    timeline?: string;
    visitDay?: string;
    leadQuality?: string;
    summary?: string;
  };
}

export function getCallerMemory(phoneNumber: string): CallerMemoryContext {
  const raw = (phoneNumber || '').trim();
  const digits = raw.replace(/\D/g, '');
  const searchSuffix = digits.length >= 8 ? digits.slice(-8) : digits;

  let lead: any = null;
  let calls: any[] = [];

  if (sqliteDb) {
    try {
      if (searchSuffix) {
        lead = sqliteDb.prepare(`
          SELECT * FROM leads 
          WHERE caller_phone LIKE ? 
          ORDER BY id DESC LIMIT 1
        `).get(`%${searchSuffix}%`);

        calls = sqliteDb.prepare(`
          SELECT * FROM calls 
          WHERE caller_number LIKE ? 
          ORDER BY id DESC LIMIT 5
        `).all(`%${searchSuffix}%`) as any[];
      }
    } catch (err: any) {
      console.warn('[DB] getCallerMemory query warning:', err.message);
    }
  }

  // Fallback in-memory search
  if (!lead && memLeads.length > 0 && searchSuffix) {
    lead = memLeads.find((l) => (l.caller_phone || '').replace(/\D/g, '').includes(searchSuffix));
  }
  if (calls.length === 0 && memCalls.length > 0 && searchSuffix) {
    calls = memCalls.filter((c) => (c.caller_number || '').replace(/\D/g, '').includes(searchSuffix));
  }

  const isReturning = Boolean(lead || calls.length > 0);
  const lastCall = calls[0];

  return {
    phoneNumber: raw,
    isReturningCaller: isReturning,
    totalPreviousCalls: Math.max(calls.length, lead ? 1 : 0),
    lastCallDate: lastCall?.created_at || lead?.created_at,
    lastCallSummary: lastCall?.summary || lead?.summary,
    existingLead: lead
      ? {
          callerName: lead.caller_name || 'Valued Buyer',
          config: lead.config,
          budget: lead.budget,
          intent: lead.intent,
          location: lead.location,
          timeline: lead.timeline,
          visitDay: lead.visit_day,
          leadQuality: lead.lead_quality || lead.status,
          summary: lead.summary,
        }
      : undefined,
  };
}
