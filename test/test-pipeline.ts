import { normalizeRealEstateText } from '../src/pipeline/normalizer.js';
import { initDatabase, createCall, updateCall, insertLead, getCalls, getLeads, exportLeadsToCsv } from '../src/tools/db.js';

console.log('--- Testing Normalizer ---');

const testCases = [
  {
    input: 'Looking for a 3 bhk in Jakkur around 1.8 Cr for self-use at Mittal Palms.',
    expectedContains: ['3 B H K', 'one point eight crore rupees'],
  },
  {
    input: 'My budget is 1.35 Cr and I want ready to move 2 BHK at Mittal Palms.',
    expectedContains: ['one point three five crore rupees', 'Mittal Palms'],
  },
  {
    input: 'We need a 3 BHK in Jakkur under 1.95 Crores.',
    expectedContains: ['3 B H K', 'one point nine five crore rupees'],
  },
  {
    input: 'Visit scheduled for 11 AM this Saturday with Raghavendra.',
    expectedContains: ['11 A M', 'Saturday'],
  },
];

for (const tc of testCases) {
  const output = normalizeRealEstateText(tc.input);
  console.log(`Input:    "${tc.input}"`);
  console.log(`Output:   "${output}"`);
  for (const exp of tc.expectedContains) {
    if (!output.toLowerCase().includes(exp.toLowerCase())) {
      console.error(`FAILED: Expected to find "${exp}" in output`);
      process.exit(1);
    }
  }
}
console.log('✓ Normalizer passed all test cases!\n');

console.log('--- Testing SQLite Database ---');
initDatabase();
const callId = createCall('test_stream_123', '+919880012345');
console.log(`Created test call ID: ${callId}`);

insertLead({
  call_id: callId,
  caller_phone: '+919880012345',
  caller_name: 'Rahul Sharma',
  config: '3 BHK',
  intent: 'Self-use',
  location: 'Jakkur, North Bangalore',
  budget: '1.7 - 1.95 Cr',
  timeline: 'Ready to move',
  visit_day: 'Saturday 11 AM with Raghavendra',
  status: 'Hot - Visit Booked',
  summary: 'Client interested in ready 3 BHK at Mittal Palms in Jakkur.',
  lead_email: 'niraj@mittal.com',
});

updateCall(callId, 45, 'Caller: Hello\nPriya: Hi', 'Inquiry for 3 BHK at Mittal Palms, Jakkur.');

const calls = getCalls(5);
const leads = getLeads(5);
console.log(`Retrieved calls count: ${calls.length}, lead count: ${leads.length}`);

if (calls.length === 0 || leads.length === 0) {
  console.error('Database verification failed: empty calls or leads');
  process.exit(1);
}

const csv = exportLeadsToCsv();
console.log('CSV Export Preview:\n' + csv.split('\n').slice(0, 3).join('\n'));
console.log('✓ Database audit and CSV export passed!\n');
