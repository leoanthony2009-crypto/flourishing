// Static checks on the design source. Catches the classes of breakage that the
// localStorage -> Supabase migration can reintroduce, without needing a browser.
//   node checks.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = 'design/Bloom Principal Pulse.dc.html';
const src = readFileSync(SRC, 'utf8');
const at = src.indexOf('<script type="text/x-dc" data-dc-script');
const logicStart = src.indexOf('>', at) + 1;
const markup = src.slice(0, at);
const logic = src.slice(logicStart, src.indexOf('</script>', logicStart));

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : '\n        ' + detail}`);
  if (!ok) failures.push(name);
};

// 1. The logic block must parse.
let parses = true, parseErr = '';
try { new vm.Script(logic); } catch (e) { parses = false; parseErr = e.message; }
check('logic block parses', parses, parseErr);

// 2. Every {{ binding }} in the markup must be produced by renderVals().
const aliases = new Set([...markup.matchAll(/as="([A-Za-z_$][\w$]*)"/g)].map(m => m[1]).concat(['true', 'false']));
const used = [...new Set([...markup.matchAll(/\{\{\s*([A-Za-z_$][\w$]*)/g)].map(m => m[1]))].filter(n => !aliases.has(n));
const vals = logic.slice(logic.indexOf('  renderVals() {'));
const missing = used.filter(n => !new RegExp(`(?<![\\w$.])${n}\\s*[:,]`).test(vals));
check(`all ${used.length} template bindings resolve`, missing.length === 0, 'missing: ' + missing.join(', '));

// 3. Drafts are the only thing still allowed in localStorage (per the handoff mapping).
const storage = [...logic.matchAll(/localStorage\.\w+\(([^)]*)\)/g)].map(m => m[1].trim());
const strayStorage = storage.filter(a => !a.includes('bloom-pulse-draft'));
check('localStorage is only used for drafts', strayStorage.length === 0, 'stray: ' + strayStorage.join(' | '));

// 4. The seeded demo data and the per-device client model must be gone from the code.
//    Comments still name them (they explain what replaced them), so strip those first.
const code = logic
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
for (const dead of ['PAST', 'CURRENT', 'DEMO_BASE_POINTS', 'window.claude', 'state.submissions', 'pendingSchool']) {
  check(`no reference to ${dead}`, !new RegExp(`(?<![\\w$.'"-])${dead.replace('.', '\\.')}(?![\\w$])`).test(code));
}

// 4b. Copy from the prototype that is now simply untrue. The Account sheet told principals
//     their data was "seeded demo data" held "on this device" — it is in Supabase, scoped to
//     their school by RLS. A privacy promise is worth nothing if the app contradicts it two
//     screens later. These strings are checked against the whole template, not just the logic.
for (const stale of [
  'seeded demo data',
  'on this device use',
  'Your school and this demo',
  'Account and demo settings',
]) check(`stale prototype copy gone: "${stale}"`, !src.includes(stale));

// 4c. Every theme must carry its evidence AND a citation a reader could check. "More help"
//     shows this material to principals as practical advice, so an entry without a source is
//     advice presented as fact. A floor, not a proof of accuracy: it cannot tell whether the
//     source supports the claim, only that one was supplied.
const topicIds = ['workload','staffing','teaching','behaviour','attendance','safeguarding',
  'parents','send','culture','confidence','resources','change','data','other'];
const micro = src.slice(src.indexOf('const MICRO'));
let missingEvidence = [], missingYear = [];
for (const t of topicIds) {
  const m = micro.match(new RegExp(`\\n  ${t}:\\{[\\s\\S]*?evidence:'((?:[^'\\\\]|\\\\.)*)',source:'((?:[^'\\\\]|\\\\.)*)'`));
  if (!m || !m[1].trim() || !m[2].trim()) { missingEvidence.push(t); continue; }
  if (!/\b(19|20)\d{2}\b/.test(m[2])) missingYear.push(t);
}
check('every theme states its evidence and cites a source', missingEvidence.length === 0, 'missing: ' + missingEvidence.join(', '));
check('every citation carries a year a reader could look up', missingYear.length === 0, 'no year: ' + missingYear.join(', '));

// 5. Each row of the handoff's "Client integration points" table must be wired.
for (const [what, needle] of [
  ['auth (magic link)', 'sendMagicLink'],
  ['profiles.school_id', 'loadProfile'],
  ['pulses upsert', 'upsertPulse'],
  ['network_pulse() RPC', 'networkPulse'],
  ['support_requests', 'insertRequest'],
  ['shared_resources', 'addShared'],
  ['points_ledger', 'listLedger'],
  ['redemptions', 'listRedemptions'],
  ['redeem function', 'BloomAPI.redeem'],
  ['tailor function', 'BloomAPI.tailor'],
]) check(`wired: ${what}`, logic.includes(needle));

// 6. The privacy rule the minimum-cell aggregate exists to enforce: the client must never
//    be handed another school's chosen theme.
check('account sheet does not reveal other schools\' themes',
  /Counted in the network view only/.test(logic));

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
