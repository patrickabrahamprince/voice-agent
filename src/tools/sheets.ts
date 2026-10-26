import { google } from 'googleapis';
import { insertLead, LeadRecord } from './db.js';

const EXPECTED_HEADERS = [
  'Timestamp',
  'Caller Phone',
  'Name',
  'Lead Quality',
  'Config',
  'Intent',
  'Location',
  'Budget',
  'Timeline',
  'Site Visit Day',
  'Status',
  'Qualification Reason',
  'Registered Lead Email',
];

export interface QualifyLeadParams {
  caller_name: string;
  phone_number: string;
  configuration: string;
  intent: string;
  location_preference: string;
  budget_bracket: string;
  possession_timeline: string;
  site_visit_day: string;
  lead_quality?: 'Good Lead' | 'Bad Lead';
  lead_status: string;
  qualification_reason?: string;
  summary?: string;
  lead_email?: string;
  call_id?: number | null;
}

class GoogleSheetsService {
  private sheetId: string;
  private clientEmail: string;
  private privateKey: string;
  private sheetsClient: ReturnType<typeof google.sheets> | null = null;
  private headerInitialized: boolean = false;

  constructor() {
    this.sheetId = process.env.GOOGLE_SHEET_ID || '';
    this.clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
    this.privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    this.initClient();
  }

  private initClient(): void {
    if (!this.sheetId || !this.clientEmail || !this.privateKey) {
      console.warn(
        '[GoogleSheets] Missing credentials (GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, or GOOGLE_PRIVATE_KEY). Leads will still be saved to SQLite fallback.'
      );
      return;
    }

    try {
      const auth = new google.auth.JWT({
        email: this.clientEmail,
        key: this.privateKey,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      this.sheetsClient = google.sheets({ version: 'v4', auth });
      console.log('[GoogleSheets] Client authenticated successfully.');
    } catch (err) {
      console.error('[GoogleSheets] Failed to initialize Google auth client:', err);
      this.sheetsClient = null;
    }
  }

  /**
   * Automatically verifies and creates header row if the sheet is blank.
   */
  async ensureHeaders(): Promise<void> {
    if (this.headerInitialized || !this.sheetsClient || !this.sheetId) {
      return;
    }

    try {
      const response = await this.sheetsClient.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range: 'A1:K1',
      });

      const rows = response.data.values;
      if (!rows || rows.length === 0 || rows[0].length === 0) {
        console.log('[GoogleSheets] Sheet is blank. Inserting header row...');
        await this.sheetsClient.spreadsheets.values.update({
          spreadsheetId: this.sheetId,
          range: 'A1:K1',
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [EXPECTED_HEADERS],
          },
        });
        console.log('[GoogleSheets] Header row created successfully.');
      }
      this.headerInitialized = true;
    } catch (err: any) {
      console.error('[GoogleSheets] Error checking/creating header row:', err?.message || err);
    }
  }

  /**
   * Appends a lead row into Google Sheet and SQLite backup.
   */
  async qualifyAndSyncLead(params: QualifyLeadParams): Promise<{ success: boolean; leadId: number; syncedToSheets: boolean }> {
    const timestamp = new Date().toISOString();
    const quality =
      params.lead_quality ||
      (params.lead_status.includes('Bad') || params.lead_status.includes('Cold') || params.lead_status.includes('Unqualified')
        ? 'Bad Lead'
        : 'Good Lead');

    const leadEmail = params.lead_email || process.env.LEAD_EMAIL || '';

    const leadRecord: LeadRecord = {
      call_id: params.call_id ?? null,
      caller_phone: params.phone_number,
      caller_name: params.caller_name,
      lead_quality: quality,
      config: params.configuration,
      intent: params.intent,
      location: params.location_preference,
      budget: params.budget_bracket,
      timeline: params.possession_timeline,
      visit_day: params.site_visit_day,
      status: params.lead_status,
      summary: params.qualification_reason || params.summary || '',
      lead_email: leadEmail,
    };

    // 1. Always insert into local SQLite audit table
    const leadId = insertLead(leadRecord);
    console.log(`[Database] Lead #${leadId} (${quality}) stored in SQLite for caller ${params.phone_number} -> Registered: ${leadEmail}`);

    let syncedToSheets = false;

    // 2. Sync to Google Sheets if credentials are present
    if (this.sheetsClient && this.sheetId) {
      try {
        await this.ensureHeaders();

        const rowValues = [
          timestamp,
          params.phone_number,
          params.caller_name,
          quality,
          params.configuration,
          params.intent,
          params.location_preference,
          params.budget_bracket,
          params.possession_timeline,
          params.site_visit_day,
          params.lead_status,
          params.qualification_reason || params.summary || '',
          leadEmail,
        ];

        await this.sheetsClient.spreadsheets.values.append({
          spreadsheetId: this.sheetId,
          range: 'A:M',
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: {
            values: [rowValues],
          },
        });

        syncedToSheets = true;
        console.log(`[GoogleSheets] Lead #${leadId} synced successfully to Sheet ID: ${this.sheetId} (Registered to ${leadEmail})`);
      } catch (err: any) {
        console.error(`[GoogleSheets] Failed to append row to Google Sheets:`, err?.message || err);
      }
    } else {
      console.log(`[GoogleSheets] Skipping Google Sheets sync (credentials missing). SQLite record saved with Registered Email: ${leadEmail}`);
    }

    return {
      success: true,
      leadId,
      syncedToSheets,
    };
  }

  async testConnection(): Promise<{ success: boolean; sheetTitle?: string; error?: string }> {
    if (!this.sheetsClient || !this.sheetId) {
      return {
        success: false,
        error: 'Google Service Account credentials or GOOGLE_SHEET_ID not configured.',
      };
    }

    try {
      const meta = await this.sheetsClient.spreadsheets.get({
        spreadsheetId: this.sheetId,
      });
      return {
        success: true,
        sheetTitle: meta.data.properties?.title || 'Untitled Sheet',
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message || 'Failed to authenticate with Google Sheets API.',
      };
    }
  }

  getSheetUrl(): string {
    return this.sheetId ? `https://docs.google.com/spreadsheets/d/${this.sheetId}` : '';
  }
}

export const sheetsService = new GoogleSheetsService();
