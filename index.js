// index.js — PDF + XML bundled into a ZIP for Make.com / Railway

const express    = require('express');
const bodyParser = require('body-parser');
const puppeteer  = require('puppeteer');
const path       = require('path');
const fs         = require('fs');
const archiver   = require('archiver');
const XLSX = require('xlsx');
const fsp = fs.promises;
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // per file; adjust if needed
});
const app = express();
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const Mailgun = require('mailgun.js');
const formData = require('form-data');

/* ---------- Static assets ---------- */
const css = fs.readFileSync(path.join(__dirname, 'public', 'styles.css'), 'utf8');
const logoData = fs.readFileSync(path.join(__dirname, 'public/images/logo4.png')).toString('base64');
const logoMime = 'image/png';

// xlsx merge dirs & state
const BUFFER_DIR = '/data/incoming-xlsx';
const MERGED_DIR = '/data/merged-xlsx';
let pendingDocFiles = [];
let pendingPartnerFiles = [];
let mergeTimer = null;
let pendingFiles = [];
const COUNTER_DIR  = process.env.COUNTER_DIR || '/data';
const COUNTER_FILE = path.join(COUNTER_DIR, 'waybill_counter.json');
const LOCK_FILE    = path.join(COUNTER_DIR, 'waybill_counter.lock');
const LEGACY_LOCK_PATH = path.join(COUNTER_DIR, 'waybill_counter.lock');     // this is the OLD *directory*


/* ensure dirs exist */
fs.mkdirSync(BUFFER_DIR, { recursive: true });
fs.mkdirSync(MERGED_DIR, { recursive: true });



/* ---------- Express config ---------- */
app.use(bodyParser.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));


/* ---------- xlsx merge Helpers ---------- */
function normalizeHeaderCell(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function aoaFromSheet(ws, XLSX) {
  // SheetJS utils: turn worksheet -> array of arrays
  return XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
}

function appendRows(master, incoming) {
  // assumes both are AOA (array of arrays)
  // keep master[0] as headers, skip incoming[0] if equals (or normalized equals)
  if (!incoming || incoming.length === 0) return;

  const mHdr = (master[0] || []).map(normalizeHeaderCell);
  const iHdr = (incoming[0] || []).map(normalizeHeaderCell);

  const headersMatch =
    mHdr.length === iHdr.length &&
    mHdr.every((h, idx) => h === iHdr[idx]);

  // start rows index after header (0) if headers match, else include all
  const start = headersMatch ? 1 : 0;
  for (let r = start; r < incoming.length; r++) {
    // pad/truncate to header length so columns line up
    const row = Array.from({ length: mHdr.length }, (_, c) => incoming[r][c] ?? '');
    master.push(row);
  }
}


// Merge many "Partneri" workbooks: append rows per sheet (skip headers after first)
function buildMergedPartnerWorkbook(buffers, XLSX, sheetNames = [
  "Partneri", "Adreses", "Bankas konti", "Kontaktpersonas", "PVN numuri",
  "Dimensijas", "Papildinformācija"
]) {
  // accumulator for each sheet: { header: string[], rows: string[][] }
  const acc = new Map();
  sheetNames.forEach(n => acc.set(n, { header: null, rows: [] }));

  for (const buf of buffers) {
    const wb = XLSX.read(buf, { type: 'buffer' });
    for (const sName of sheetNames) {
      const ws = wb.Sheets[sName];
      if (!ws) continue;

      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
      if (!aoa || aoa.length === 0) continue;

      const header = aoa[0];
      const rows   = aoa.slice(1);

      const slot = acc.get(sName);
      if (!slot.header) {
        slot.header = header;
      }
      // If headers differ across files, you could normalize here; for now we append.
      slot.rows.push(...rows);
    }
  }

  const out = XLSX.utils.book_new();
  for (const [name, { header, rows }] of acc.entries()) {
    if (!header) continue; // nothing to write for this sheet
    const aoa = [header, ...rows];
    const ws  = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(out, ws, name);
  }
  return out;
}




function buildMergedWorkbook(buffers, XLSX, opts = {}) {
  const sheetNames = opts.sheetNames || ["Noliktavas dokumenti", "Preces"];

  // master AOAs, one per expected sheet
  const masters = sheetNames.map(() => []);
  let headerLocked = sheetNames.map(() => false);

  for (const buf of buffers) {
    const wb = XLSX.read(buf, { type: 'buffer' });

    sheetNames.forEach((sheetName, idx) => {
      const ws = wb.Sheets[sheetName];
      if (!ws) return; // sheet not present in this file → skip

      const aoa = aoaFromSheet(ws, XLSX);
      if (aoa.length === 0) return;

      if (!headerLocked[idx]) {
        // initialize master with this file's header row
        masters[idx].push(aoa[0].map(v => normalizeHeaderCell(v)));
        headerLocked[idx] = true;
      }
      appendRows(masters[idx], aoa);
    });
  }

  // Build a new workbook with both sheets
  const outWb = XLSX.utils.book_new();
  masters.forEach((aoa, idx) => {
    // if a sheet never appeared in any file, keep it with just a header?
    // Here we’ll only create it if we actually have a header
    if (aoa.length > 0) {
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      XLSX.utils.book_append_sheet(outWb, ws, sheetNames[idx]);
    }
  });
  return outWb;
}



function workbookToBuffer(wb, XLSX) {
  // produce a Node Buffer for response
  const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}
/* ---------- END xlsx merge Helpers ---------- */

const mg = new Mailgun(formData).client({
  username: 'api',
  key: (process.env.MAILGUN_API_KEY || '').trim(),       // e.g. key-xxxx...
  // Use EU only if your domain is in EU region; otherwise omit or use US default
  url: (process.env.MAILGUN_BASE_URL || 'https://api.mailgun.net').trim()
});

// async function sendMergedEmail(filePath, fileName) {
//   const domain = (process.env.MAILGUN_DOMAIN || '').trim(); // e.g. sandbox…mailgun.org or mg.yourdomain.com
//   const from   = (process.env.MAIL_FROM || `Waybill API <postmaster@${domain}>`).trim();
//   const to     = (process.env.MAIL_TO   || '').trim();

//   if (!process.env.MAILGUN_API_KEY || !domain || !to) {
//     throw new Error('Missing MAILGUN_API_KEY, MAILGUN_DOMAIN, or MAIL_TO');
//   }

//   const attachmentStream = fs.createReadStream(filePath);

//   const params = {
//     from,
//     to,
//     subject: 'Balanss-V Rēķinu imports',
//     text: 'Importa fails pielikumā.',
//     // mailgun.js accepts attachments as array of { filename, data }
//     attachment: [{ filename: fileName, data: attachmentStream }]
//   };

//   try {
//     const resp = await mg.messages.create(domain, params);
//     console.log('📧 Mailgun sent:', resp.id || resp.message || resp);
//     return resp;
//   } catch (err) {
//     // Helpful diagnostics (no secrets)
//     console.error('Mailgun send failed:', {
//       status: err.status,
//       type: err.type,
//       details: err.details
//     });
//     throw err;
//   }
// }

async function sendMergedEmailWithAttachments(attachments /* [{path,filename}] */) {
  const domain = (process.env.MAILGUN_DOMAIN || '').trim();
  const from   = (process.env.MAIL_FROM || `Waybill API <postmaster@${domain}>`).trim();
  const to     = (process.env.MAIL_TO   || '').trim();

  if (!process.env.MAILGUN_API_KEY || !domain || !to) {
    throw new Error('Missing MAILGUN_API_KEY, MAILGUN_DOMAIN, or MAIL_TO');
  }

  const mgAttachments = attachments.map(a => ({
    filename: a.filename,
    data: fs.createReadStream(a.path)
  }));

  const params = {
    from, to,
    subject: 'Apvienotie importi',
    text: 'Pielikumā apvienotie XLSX faili.',
    attachment: mgAttachments
  };

  const resp = await mg.messages.create(domain, params);
  console.log('📧 Mailgun sent:', resp.id || resp.message || resp);
  return resp;
}
// --- startup init & cleanup (wrap in IIFE: no top-level await) ---
(async () => {
  try {
    // ensure the /data dir exists
    await fsp.mkdir(COUNTER_DIR, { recursive: true });

    // remove legacy dir/file if present
    try {
      const s = await fsp.stat(LEGACY_LOCK_PATH);
      if (s.isDirectory()) {
        await fsp.rm(LEGACY_LOCK_PATH, { recursive: true, force: true });
      } else {
        await fsp.unlink(LEGACY_LOCK_PATH).catch(() => {});
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('legacy lock cleanup warn:', e.message);
    }

    // also clear any stale new file lock
    await fsp.rm(LOCK_FILE, { force: true });

    console.log('🔓 cleared leftover waybill locks at startup');
  } catch (e) {
    console.warn('startup lock cleanup warn:', e.message);
  }
})();


async function ensureCounterFile() {
  try {
    // make sure the directory exists
    await fsp.mkdir(COUNTER_DIR, { recursive: true });

    // check if file exists
    await fsp.access(COUNTER_FILE, fs.constants.F_OK);
  } catch {
    // if it doesn't exist, initialize with current year + seq = 0
    const year = new Date().getFullYear();
    const initial = { year, seq: 0 };

    await fsp.writeFile(COUNTER_FILE, JSON.stringify(initial), 'utf8');
    console.log(`🆕 Created counter file at ${COUNTER_FILE}`);
  }
}

// --- file-lock helpers ---
async function acquireLock({
  timeoutMs = 15000,
  retryMs   = 25,
  staleMs   = 5000
} = {}) {
  const start = Date.now();
  while (true) {
    try {
      const fh = await fsp.open(LOCK_FILE, 'wx');         // atomic create (fails if exists)
      await fh.writeFile(`${process.pid}:${Date.now()}`, 'utf8');
      await fh.close();
      return; // got the lock
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // check staleness
      try {
        const st = await fsp.stat(LOCK_FILE);
        if (Date.now() - st.mtimeMs > staleMs) {
          await fsp.rm(LOCK_FILE, { force: true });
          continue;
        }
      } catch {
        // couldn't stat/remove; just retry
      }

      if (Date.now() - start > timeoutMs) {
        // last resort: force clear and one more attempt
        try { await fsp.rm(LOCK_FILE, { force: true }); } catch {}
        try {
          const fh = await fsp.open(LOCK_FILE, 'wx');
          await fh.writeFile(`${process.pid}:${Date.now()}`, 'utf8');
          await fh.close();
          return;
        } catch {
          throw new Error('Could not acquire counter lock');
        }
      }
      await new Promise(r => setTimeout(r, retryMs));
    }
  }
}

async function releaseLock() {
  try { await fsp.rm(LOCK_FILE, { force: true }); } catch {}
}

// optional: log & try release on shutdown (don’t force-exit)
process.on('SIGTERM', () => {
  console.log('Received SIGTERM; releasing waybill lock if present…');
  releaseLock().catch(() => {});
});

function formatWaybillNumber(seq) {
  return String(seq).padStart(4, '0');
}

async function getNextWaybillNumber() {
  await ensureCounterFile();     // makes sure COUNTER_FILE exists
  await acquireLock();           // file-based lock to prevent races
  try {
    const nowYear = new Date().getFullYear();

    // 1) read current state
    let state = { year: nowYear, seq: 0 };
    try {
      const raw = await fsp.readFile(COUNTER_FILE, 'utf8');
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed.seq === 'number') {
        state = {
          year: typeof parsed.year === 'number' ? parsed.year : nowYear,
          seq:  parsed.seq
        };
      }
    } catch {
      // first run / empty file → keep defaults
    }

    // 2) reset on new year (keeps the number clean while still yearly scoped)
    if (state.year !== nowYear) {
      state.year = nowYear;
      state.seq  = 0;
    }

    // 3) increment
    state.seq += 1;

    // 4) atomic write (tmp + rename)
    const tmp = COUNTER_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(state), 'utf8');
    await fsp.rename(tmp, COUNTER_FILE);

    // 5) return the padded number (no prefix/year)
    return formatWaybillNumber(state.seq);
  } finally {
    await releaseLock();
  }
}
// In your getNextWaybillNumber(), keep using acquireLock()/releaseLock()
// around the read -> increment -> atomic write of COUNTER_FILE.

// Latvian dd.MM.yyyy
function lvDate(d = new Date()) {
  return new Intl.DateTimeFormat('lv-LV', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  }).format(d);
}

  // Build an .xlsx buffer from headers + rows
function buildXlsxBufferTwoSheets({ sheet1, sheet2 }) {
  const wb  = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet([ sheet1.headers, ...sheet1.rows ]);
  const ws2 = XLSX.utils.aoa_to_sheet([ sheet2.headers, ...sheet2.rows ]);
  XLSX.utils.book_append_sheet(wb, ws1, sheet1.name);
  XLSX.utils.book_append_sheet(wb, ws2, sheet2.name);
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }); // <-- Buffer
}

// uses SheetJS (XLSX) and path/fs as in your project
function saveTwoSheetXlsx({ sheet1, sheet2, asciiFilename }, outputDir = "./") {
  const wb = XLSX.utils.book_new();

  const ws1 = XLSX.utils.aoa_to_sheet([ sheet1.headers, ...sheet1.rows ]);
  XLSX.utils.book_append_sheet(wb, ws1, sheet1.name);

  const ws2 = XLSX.utils.aoa_to_sheet([ sheet2.headers, ...sheet2.rows ]);
  XLSX.utils.book_append_sheet(wb, ws2, sheet2.name);

  const fullPath = path.join(outputDir, `${asciiFilename}.xlsx`);
  XLSX.writeFile(wb, fullPath, { bookType: 'xlsx' });

  return fullPath; // in case you want to zip/send it
}




function numberToWords(n) {
  if (n < 0) return '';
  const single = ['', 'viens', 'divi', 'trīs', 'četri', 'pieci', 'seši', 'septiņi', 'astoņi', 'deviņi'];
  const teens  = ['desmit','vienpadsmit','divpadsmit','trīspadsmit','četrpadsmit','piecpadsmit','sešdpadsmit','septiņpadsmit','astoņpadsmit','deviņpadsmit'];
  const tens   = ['divdesmit','trīsdesmit','četrdesmit','piecdesmit','sešdesmit','septiņdesmit','astoņdesmit','deviņdesmit'];

  if (n === 0) return '0 ';
  function t(x) {
    if (x < 10) return single[x] + ' ';
    if (x < 20) return teens[x - 10] + ' ';
    if (x < 100) return tens[Math.floor(x / 10) - 2] + ' ' + t(x % 10);
    if (x < 1000) {
      const h = Math.trunc(x / 100);
      return single[h] + ' ' + (h === 1 ? 'simts ' : 'simti ') + t(x % 100);
    }
    if (x < 1_000_000) {
      const th = Math.trunc(x / 1000);
      return t(th).trim() + ' ' + (th === 1 ? 'tūkstotis ' : 'tūkstoši ') + t(x % 1000);
    }
    const m = Math.trunc(x / 1_000_000);
    return t(m).trim() + ' ' + (m === 1 ? 'miljons ' : 'miljoni ') + t(x % 1_000_000);
  }
  return t(n);
}

function flipName(fullName) {
  const parts = fullName.trim().split(/\s+/); // split by any whitespace
  if (parts.length < 2) return fullName;      // nothing to flip
  const first = parts.shift();                // take first
  const last  = parts.pop();                  // take last
  return [last, ...parts, first].join(' ');
}

const cap = s => (s && s[0] ? s[0].toUpperCase() + s.slice(1) : s || '');


// Turn request body into AOAs for TWO sheets:
//  - sheet1: "Noliktavas dokumenti" (full import schema, with "Noliktavas dokumenta ID" first)
//  - sheet2: "Preces" (per-line simplified overview)
function buildTablesForXlsx(data, totals) {
  const {
    sumVatBase, vatAmount, totalCost, sumDisc,
    todaysDate, payment_date_due
  } = totals;

  // ---------- SHEET 1: single document-level row ----------
  const headers1 = [
    "Noliktavas dokumenta ID",
    "Dokumenta Nr.","Dokumenta Nr. (veidlapas sērija)","Dokumenta datums","Dokumenta tips (saīsinājums)","Dokumenta veids",
    "Dokumenta valūta","Dokumenta valūtas kurss","Dokumenta uzņēmuma PVN maksātāja valsts","Dokumenta uzņēmuma PVN numurs",
    "Dokumenta partnera nosaukums","Dokumenta partnera reģ.nr./pers.kods","Dokumenta partnera e-pasts",
    "Dokumenta partnera PVN maksātāja valsts","Dokumenta partnera PVN numurs","Dokumenta partnera kontaktpersona",
    "Dokumenta darbinieka/aģenta nosaukums","Dokumenta uzņēmuma noliktavas adrese","Dokumenta partnera noliktavas adrese",
    "Dokumenta PVN likme (noklusētā)","Dokumenta summa","Dokumenta PVN summa","Dokumenta summa apmaksai",
    "Dokumenta atlaides %","Dokumenta atlaides summa","Dokumenta apmaksas termiņš","Dokumenta apmaksas veids",
    "Dokumenta piegādes datums","Dokumenta kontēšanas veidne","Dokumenta kopsummu aprēķina veids","Dokumenta piezīmes (papildus noteikumi)",
    // line-level columns remain in header but will be left empty in this single row:
    "Dimensijas kods","Dimensijas nosaukums","Papildinformācijas nosaukums","Papildinformācija",
    "Rindiņas preces kods","Rindiņas preces svītrkods","Rindiņas preces papildkods","Rindiņas uzskaites grupa (saīsinājums)",
    "Rindiņas mērvienība","Rindiņas daudzums","Rindiņas cena","Rindiņas cena EUR","Rindiņas iepirkšanas cena",
    "Rindiņas uzskaites vērtība EUR","Rindiņas atlaides %","Rindiņas cena ar PVN un atlaidēm","Rindiņas PVN likme","Rindiņas summa apmaksai",
    "Rindiņas preces izcelsmes valsts kods","Rindiņas preces KN kods","Rindiņas akcīzes nodoklis","Rindiņas derīguma termiņš","Rindiņas sertifikāts",
    "Rindiņas noliktava (no kuras paņem preci)","Rindiņas noliktava (kurā novieto preci)","Rindiņas piezīmes",
    "Sastāvdaļas preces kods","Sastāvdaļas preces svītrkods","Sastāvdaļas preces papildkods","Sastāvdaļas uzskaites grupa (saīsinājums)",
    "Sastāvdaļas mērvienība","Sastāvdaļas daudzums","Sastāvdaļas derīguma termiņš","Sastāvdaļas sertifikāts","Sastāvdaļas preces KN kods",
    "Sastāvdaļas noliktava (no kuras paņem preci)","Sastāvdaļas piezīmes",
    "PVN izvērsums - apliekamā summa","PVN izvērsums - PVN","PVN izvērsums - PVN likme"
  ];

  const docId        = data.documentNumber || "0000";
  const agentFlipped = flipName(data.agent);

  // document-level values only
  const docRowMap = {
    "Noliktavas dokumenta ID":                 docId,
    "Dokumenta Nr.":                           docId,
    "Dokumenta Nr. (veidlapas sērija)":        "BAL-V/GEN",
    "Dokumenta datums":                        todaysDate,
    "Dokumenta tips (saīsinājums)":            "Rēķins",
    "Dokumenta veids":                         "Standarta",
    "Dokumenta valūta":                        "EUR",
    "Dokumenta valūtas kurss":                 "",
    "Dokumenta uzņēmuma PVN maksātāja valsts": "LV",
    "Dokumenta uzņēmuma PVN numurs":           "LV40203552764",
    "Dokumenta partnera nosaukums":            data.reciever || "",
    "Dokumenta partnera reģ.nr./pers.kods":    data.reg_number_reciever || "",
    "Dokumenta partnera e-pasts":              data.reciever_email || "",
    "Dokumenta partnera PVN maksātāja valsts": "",
    "Dokumenta partnera PVN numurs":           "",
    "Dokumenta partnera kontaktpersona":       "",
    "Dokumenta darbinieka/aģenta nosaukums":   agentFlipped || "",
    "Dokumenta uzņēmuma noliktavas adrese":    "",
    "Dokumenta partnera noliktavas adrese":    data.recieving_location || "",
    "Dokumenta PVN likme (noklusētā)":         "21",
    "Dokumenta summa":                         (Number(sumVatBase) || 0).toFixed(2),
    "Dokumenta PVN summa":                     (Number(vatAmount)  || 0).toFixed(2),
    "Dokumenta summa apmaksai":                (Number(totalCost)  || 0).toFixed(2),
    "Dokumenta atlaides %":                    "",
    "Dokumenta atlaides summa":                (Number(sumDisc)    || 0).toFixed(2),
    "Dokumenta apmaksas termiņš":              payment_date_due,
    "Dokumenta apmaksas veids":                "Pārskaitījums",
    "Dokumenta piegādes datums":               todaysDate,
    "Dokumenta kontēšanas veidne":             "NĪV",
    "Dokumenta kopsummu aprēķina veids": (data.products?.some(p => p.price_includes_vat === false) ? "no cenas" : "no cenas ar nodokli"),
    "Dokumenta piezīmes (papildus noteikumi)": `Dokuments ir sagatavots elektroniski un derīgs bez paraksta atbilstoši "Grāmatvedības Likuma" 11.panta nosacījumiem.`,
    // Everything below is line-level — keep empty on Sheet 1:
    "Dimensijas kods":"", "Dimensijas nosaukums":"", "Papildinformācijas nosaukums":"", "Papildinformācija":"",
    "Rindiņas preces kods":                     "0001"
    , "Rindiņas preces svītrkods":"", "Rindiņas preces papildkods":"", "Rindiņas uzskaites grupa (saīsinājums)":"",
    "Rindiņas mērvienība":"", "Rindiņas daudzums":"", "Rindiņas cena":"", "Rindiņas cena EUR":"", "Rindiņas iepirkšanas cena":"",
    "Rindiņas uzskaites vērtība EUR":"", "Rindiņas atlaides %":"", "Rindiņas cena ar PVN un atlaidēm":"", "Rindiņas PVN likme":"", "Rindiņas summa apmaksai":"",
    "Rindiņas preces izcelsmes valsts kods":"", "Rindiņas preces KN kods":"", "Rindiņas akcīzes nodoklis":"", "Rindiņas derīguma termiņš":"", "Rindiņas sertifikāts":"",
    "Rindiņas noliktava (no kuras paņem preci)":"", "Rindiņas noliktava (kurā novieto preci)":"", "Rindiņas piezīmes":"",
    "Sastāvdaļas preces kods":"", "Sastāvdaļas preces svītrkods":"", "Sastāvdaļas preces papildkods":"", "Sastāvdaļas uzskaites grupa (saīsinājums)":"",
    "Sastāvdaļas mērvienība":"", "Sastāvdaļas daudzums":"", "Sastāvdaļas derīguma termiņš":"", "Sastāvdaļas sertifikāts":"",
    "Sastāvdaļas preces KN kods":"", "Sastāvdaļas noliktava (no kuras paņem preci)":"", "Sastāvdaļas piezīmes":"",
    "PVN izvērsums - apliekamā summa":"", "PVN izvērsums - PVN":"", "PVN izvērsums - PVN likme":"21"
  };

  // exactly ONE row for sheet 1:
  const rows1 = [ headers1.map(h => docRowMap[h] ?? "") ];

  // ---------- SHEET 2: one row per product ----------
  const headers2 = [
    "Noliktavas dokumenta ID",
    "Rindiņas cena",
    "Rindiņas preces kods",
    "Rindiņas uzskaites grupa (saīsinājums)",
    "Rindiņas preces svītrkods",
    "Rindiņas preces nosaukums",
    "Rindiņas preces papildkods",
    "Rindiņas mērvienība",
    "Rindiņas daudzums",
    "Rindiņas uzskaites vērtība EUR",
    "Rindiņas atlaides %",
    "Rindiņas PVN likme",
    "Rindiņas preces izcelsmes valsts kods",
    "Rindiņas preces KN kods",
    "Rindiņas akcīzes nodoklis",
    "Rindiņas derīguma termiņš",
    "Rindiņas sertifikāts",
    "Rindiņas noliktava (no kuras paņem preci)",
    "Rindiņas noliktava (kurā novieto preci)",
    "Rindiņas piezīmes",
    "Rindiņas degvielas blīvums",
    "Rindiņas degvielas sēra saturs",
    "Rindiņas degvielas temperatūra"
  ];

  const rows2 = (data.products || []).map(prod => {
    const quantity    = Number(prod.quantity) || 1;
    const priceRaw    = Number(prod.price)    || 0;
    const vatRate     = prod.hasOwnProperty('vat') ? Number(prod.vat)/100 : 0.21;
    const includesVat = prod.hasOwnProperty('price_includes_vat') ? Boolean(prod.price_includes_vat) : true;
    const netUnit     = includesVat ? priceRaw / (1 + vatRate) : priceRaw;

    const code  = prod.description === "Ceļa izdevumi" ? "'0004" : "'0001";
    const name  = prod.description || "Prece/Pakalpojums";
    const unit  = prod.unit || "gab";
    const notes = prod.product_location || data.recieving_location || "";

    return [
      docId,                           // Noliktavas dokumenta ID
      netUnit.toFixed(2),              // Rindiņas cena (bez PVN, vienības cena)
      code,                            // Rindiņas preces kods
      "*",                             // Rindiņas uzskaites grupa (saīsinājums)
      "",                              // Rindiņas preces svītrkods
      name,                            // Rindiņas preces nosaukums
      "",                              // Rindiņas preces papildkods
      unit,                            // Rindiņas mērvienība
      quantity,                        // Rindiņas daudzums
      "",                              // (netUnit * quantity).toFixed(2), // Rindiņas uzskaites vērtība EUR (bez PVN)
      "0",                             // Rindiņas atlaides %
      (vatRate*100).toFixed(0),        // Rindiņas PVN likme
      "", "", "", "", "", "", "",      // origin/KN/akcīze/derīg./sert./noliktavas…
      notes,                           // Rindiņas piezīmes
      "", "", ""                       // degv. blīvums / sēra saturs / temp.
    ];
  });

  // ---------- Filename (ASCII-safe) ----------
  const baseFilename  = `Rekins__${String(data.reciever || 'waybill').trim()}`;
  const asciiFilename = baseFilename
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "_");

  return {
    sheet1: { headers: headers1, rows: rows1, name: "Noliktavas dokumenti" },
    sheet2: { headers: headers2, rows: rows2, name: "Preces" },
    asciiFilename
  };
}

function buildPartnerWorkbook(data) {
  // helpers
  const reciever = (data.reciever || '').trim();
  const recieverEmail = (data.reciever_email || '').trim();
  const regNo = (data.reg_number_reciever || '').trim();
  const addr = (data.address_reciever || data.recieving_location || '').trim();


  const [firstName, ...restLast] = reciever.split(/\s+/);
  const lastName = restLast.join(' ').trim();

  // Filename (ASCII-safe)
  const baseFilename = `Partneri__${(reciever || 'partner').trim()}`;
  const asciiFilename = baseFilename
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '_');

  // ---------- Sheet 1: Partneri ----------
  const H1 = [
    "Partnera ID","Partnera nosaukums","Partnera vārds","Partnera uzvārds","Partnera veids","Partnera uzruna","Partnera kods","Partnera tips","Partnera reģistrācijas numurs","Partnera personas kods","Partnera nodokļu maksātāja tips","Partnera piezīmes","Partnera piezīmes (drukājamās)","Partnera telefons","Partnera e-pasts","Partnera fakss","Partnera web adrese","Partnera SEZ kods","Partnera pases Nr.","Partnera pases izsniegšanas datums","Partnera pases izdevējs","Partnera norēķinu veids","Partnera kredītlimits","Partnera kredīttermiņš (dienās)","Partnera kredītstatusa piezīmes","Partneris - preču noliktava (pazīmes ID)","Partneris - kokmateriālu pārvadātājs (pazīmes ID)","Partneris - avansa norēķinu persona (pazīmes ID)","Parāda administrēšanas process","Partnera dzimšanas datums","Partnera nodokļu sociālā tipa ID","Partneris - ieslodzītais","Partneris - pensionārs"
  ];
  const R1 = [
    data.documentNumber || "0000",
    "",                // Partnera nosaukums
    firstName || "",         // Partnera vārds
    lastName || "",          // Partnera uzvārds
    "Fiziska persona", "", "Imp", "",          // veids, uzruna, kods, tips
    regNo,                   // reģistrācijas numurs (vai personas kods if you prefer)
    "",                      // Partnera personas kods
    "Neapliekama persona, LV",                      // nodokļu maksātāja tips
    "", "",                  // piezīmes, drukājamās
    "",                      // telefons
    recieverEmail,           // e-pasts
    "", "", "",              // fakss, web, SEZ kods
    "", "",                  // pase Nr., izsniegšanas datums
    "",                      // pases izdevējs
    "", "", "",              // norēķinu veids, kredītlimits, kredīttermiņš
    "",                      // kredītstatusa piezīmes
    "", "", "",              // noliktava pazīme, kokmat. pārvad., avansa persona
    "",                      // parādu administrēšanas process
    "", "", "",              // dzimšanas datums, sociālā tipa ID, ieslodzītais
    ""                       // pensionārs
  ];

  // ---------- Sheet 2: Adreses ----------
  const H2 = [
    "Partnera ID","Adreses iela","Adrese - juridiskā (pazīmes ID)","Adrese - piegādes (pazīmes ID)","Adreses pilsēta","Adreses novads","Adreses valsts kods","Adreses pasta indekss","Adreses piezīmes"
  ];
  const R2 = [
    data.documentNumber || "0000",
    addr,   // full address in one cell (you can split if you have parsing)
    "",     // juridiskā pazīme
    "",     // piegādes pazīme
    "",     // pilsēta
    "",     // novads
    "LV",     // valsts kods (e.g., "LV" if you can detect)
    "",     // pasta indekss
    ""      // piezīmes
  ];

  // ---------- Sheet 3: Bankas konti ----------
  const H3 = [
    "Partnera ID","Konta Nr.","Konta bankas kods","Konts - pamatkonts (pazīmes ID)","Konta valūta","Konta bankas nosaukums","Konta subkonta Nr.","Konta piezīmes"
  ];
  const R3 = [
    "",
    "",   // Konta Nr.
    "",         // bankas kods (BIC) if you have it
    "",         // pamatkonts pazīme
    "", // valūta
    "",   // bankas nosaukums
    "",         // subkonta Nr.
    ""          // piezīmes
  ];

  // ---------- Sheet 4: Kontaktpersonas ----------
  const H4 = [
    "Partnera ID","Kontaktpersonas vārds","Kontaktpersonas uzvārds","Kontaktpersonas adreses iela","Kontaktpersonas uzruna","Kontaktpersonas personas kods","Kontaktpersonas amats","Kontaktpersonas telefons","Kontaktpersonas e-pasts","Kontaktpersonas personu apliecinošs dokuments","Kontaktpersonas piezīmes","Kontaktpersonas adreses pilsēta","Kontaktpersonas adreses rajons","Kontaktpersonas adreses valsts kods","Kontaktpersonas adreses pasta indekss","Kontaktpersonas adreses piezīmes"
  ];
  const R4 = [
    data.documentNumber || "0000",
    firstName || "", 
    lastName || "",
    addr,
    "",
    "",
    "",
    "",
    recieverEmail,
    "",
    "",
    "",
    "",
    "",
    "",
    ""
  ];



  const H5 = [
    "Partnera ID","PVN numurs","PVN numura valsts kods", "PVN numurs - galvenais (pazīmes ID)"
  ];
  const R5 = [
    "",     
    "",    
    "",    
    ""   
  ];

  const H6 = [
    "Partnera ID","Dimensijas kods","Dimensijas nosaukums"
  ];
  const R6 = [
    "",     
    "",    
    ""     
  ];

  const H7 = [
    "Partnera ID","Papildinformācija", "Papildinformācijas nosaukums"
  ];
  const R7 = [
    "",    
    "",    
    ""    
  ];

  // build workbook
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([H1, R1]), "Partneri");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([H2, R2]), "Adreses");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([H3, R3]), "Bankas konti");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([H4, R4]), "Kontaktpersonas");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([H5, R5]), "PVN numuri");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([H6, R6]), "Dimensijas");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([H7, R7]), "Papildinformācija");

  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
  return { buffer, filename: `${asciiFilename}.xlsx` };
}

/* ---------- Main API ---------- */
app.post('/api/waybill', async (req, res) => {
  try {
    const data = req.body; // expects { reciever, reg_number_reciever, recieving_location, products: [ { description, price, quantity?, vat?, price_includes_vat? }, ... ] }

    
     // Assign waybill/document number if not provided
    if (!data.documentNumber) {
      data.documentNumber = await getNextWaybillNumber();  // <-- persists + increments
    }


    // Normalize items (also compute line totals for your template)
    const products = (data.products || []).map(item => {
      const quantity  = item.quantity ?? 1;
      const discount  = item.discount ?? 0;
      const vat       = item.vat      ?? 21;
      const vatRate   = vat / 100;
      const price     = Number(item.price) || 0;
      const inclVat   = item.hasOwnProperty('price_includes_vat') ? Boolean(item.price_includes_vat) : true;

      const netUnitPrice = inclVat ? price / (1 + vatRate) : price;
      const discountedNetUnit   = netUnitPrice * (1 - discount/100);
      const discountedGrossUnit = discountedNetUnit * (1 + vatRate);
      const total = Number((discountedGrossUnit * quantity).toFixed(2));

      const product_location = item.product_location?.trim()
        ? item.product_location
        : (data.recieving_location || '');

      const description = item.description?.trim()
        ? item.description
        : 'Īpašuma vērtēšanas pakalpojumi';

      return {
        ...item,
        documentNumber:  data.documentNumber,
        description,
        unit:            item.unit ?? 'gab',
        quantity,
        discount,
        vat,
        total,
        product_location,
        displayPrice:    netUnitPrice.toFixed(2),
        netUnitPrice:    netUnitPrice,                 // keep numeric for sums
        grossUnitPrice:  discountedGrossUnit.toFixed(2)
      };
    });
    data.products = products;

    // Totals for document-level fields
    let sumDisc = 0;
    let sumVatBase = 0;
    let sumNoVatBase = 0;
    const vats = [];

    products.forEach(item => {
      const grossNet = item.netUnitPrice * item.quantity;  // net before VAT
      const discAmt  = grossNet * (item.discount || 0) / 100;
      const netAfterDiscount = grossNet - discAmt;

      sumDisc += discAmt;
      if ((item.vat || 0) === 0) sumNoVatBase += netAfterDiscount;
      else sumVatBase += netAfterDiscount;

      vats.push(item.vat || 0);
    });

    const maxVat       = vats.length ? Math.max(...vats) : 0;
    const vatAmount    = sumVatBase * maxVat / 100;
    const withVatValue = sumVatBase + vatAmount;
    const totalCost    = withVatValue + sumNoVatBase;

    // Dates
    const now = new Date();
    const due = new Date(now); due.setDate(now.getDate() + 10);
    const todaysDate = lvDate(now);            // dd.MM.yyyy
    const payment_date_due = lvDate(due);      // dd.MM.yyyy
    const delivery_date = todaysDate;

    // In-words
    const euros = Math.floor(totalCost);
    const cents = Math.round((totalCost - euros) * 100);
    const totalWords = `${cap(numberToWords(euros))} eiro un ${cap(numberToWords(cents))}${cents === 1 ? ' cents' : ' centi'}`;

    // Render EJS → HTML
    const renderLocals = {
      ...data,
      css,
      logoData,
      logoMime,
      documentNumber: data.documentNumber,
      products,
      sumDisc:      sumDisc.toFixed(2),
      sumNoVatBase: sumNoVatBase.toFixed(2),
      sumVatBase:   sumVatBase.toFixed(2),
      vatAmount:    vatAmount.toFixed(2),
      withVatValue: withVatValue.toFixed(2),
      totalCost:    totalCost.toFixed(2),
      totalWords,
      todaysDate,
      delivery_date,
      payment_date_due
    };

    const html = await new Promise((resolve, reject) => {
      app.render('waybills', renderLocals, (err, str) => err ? reject(err) : resolve(str));
    });

    // Headless PDF
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.emulateMediaType('print');
    await page.setViewport({ width: 2100, height: 2970, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0', url: 'http://localhost:3000' });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      scale: 1,
      margin: { top:'0mm', right:'0mm', bottom:'0mm', left:'0mm' }
    });
    await browser.close();

   // Build table and files
    // const { headers, rows, baseFilename } = buildTableFromBody(data, {
    //   sumVatBase, vatAmount, totalCost, sumDisc, todaysDate, payment_date_due
    // });

    // 1) Excel buffer
    // const xlsxBuffer = buildXlsxBuffer(headers, rows);
    // somewhere in your /api/waybill handler, after you computed totals etc.
    const tables = buildTablesForXlsx(data, {
      sumVatBase, vatAmount, totalCost, sumDisc, todaysDate, payment_date_due
    });

    const { buffer: partnerBuf, filename: partnerFilename } = buildPartnerWorkbook(data);


    
    // //// ZIP (PDF + XLSX)
    // // 1) Build XLSX buffer for the ZIP
    // const xlsxBuffer = buildXlsxBufferTwoSheets(tables);

    // // 2) Ensure PDF is a Buffer
    // const pdfBufferNode = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);

    // // 3) Stream ZIP (PDF + XLSX)
    // // use the safe ASCII filename returned by buildTablesForXlsx
    // const zipBase = tables.asciiFilename || 'waybill';

    // res.set({
    //   'Content-Type': 'application/zip',
    //   'Content-Disposition': `attachment; filename="${zipBase}.zip"`
    // });

    // const archive = archiver('zip', { zlib: { level: 9 } });
    // archive.on('error', err => {
    //   console.error('ZIP error:', err);
    //   if (!res.headersSent) res.status(500).end('ZIP error');
    // });
    // archive.pipe(res);

    // // Append files (Buffers/Streams only)
    // archive.append(pdfBufferNode, { name: `${zipBase}.pdf` });
    // archive.append(xlsxBuffer,    { name: `${zipBase}.xlsx` });

    // await archive.finalize();
    // //// ZIP (PDF + XLSX)
    //// ZIP (PDF + XLSX + Partneri)
    const xlsxBuffer = buildXlsxBufferTwoSheets(tables);
    const pdfBufferNode = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
    const zipBase = tables.asciiFilename || 'waybill';

    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipBase}.zip"`
    });

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => {
      console.error('ZIP error:', err);
      if (!res.headersSent) res.status(500).end('ZIP error');
    });
    archive.pipe(res);

    // existing files
    archive.append(pdfBufferNode, { name: `${zipBase}.pdf` });
    archive.append(xlsxBuffer,    { name: `${zipBase}.xlsx` });

    // NEW: partner workbook
    archive.append(partnerBuf,    { name: partnerFilename || 'Partneri.xlsx' });

    await archive.finalize();




  } catch (err) {
    console.error('Generation error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate bundle.' });
  }
});


app.post('/api/merge-xlsx', upload.any(), async (req, res) => {
  try {
    const xlsxFiles = (req.files || []).filter(f =>
      f.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      /\.xlsx$/i.test(f.originalname || '')
    );

    if (xlsxFiles.length === 0) {
      return res.status(400).json({ error: 'No .xlsx files uploaded.' });
    }

    for (const f of xlsxFiles) {
      const safeName = Date.now() + '_' + (f.originalname || 'file.xlsx').replace(/[^\w.-]/g, '_');
      const fullPath = path.join(BUFFER_DIR, safeName);
      fs.writeFileSync(fullPath, f.buffer);

      // classify: filename contains "partner" (covers Partneris/Partneri)
      const isPartner = /partner/i.test(f.originalname || '');
      if (isPartner) {
        pendingPartnerFiles.push(fullPath);
      } else {
        pendingDocFiles.push(fullPath);
      }
    }

    console.log(`📥 Queued: docs=${pendingDocFiles.length}, partneri=${pendingPartnerFiles.length}`);

    if (!mergeTimer) {
      console.log('⏱️ Starting 60s merge timer…');
      mergeTimer = setTimeout(async () => {
        try {
          const attachments = [];

          // --- Merge document files (Noliktavas dokumenti + Preces) ---
          if (pendingDocFiles.length > 0) {
            const buffers = pendingDocFiles.map(p => fs.readFileSync(p));
            const mergedWb = buildMergedWorkbook(buffers, XLSX, {
              sheetNames: ["Noliktavas dokumenti", "Preces"]
            });
            const outBuf = workbookToBuffer(mergedWb, XLSX);
            const mergedName = `merged_docs_${Date.now()}.xlsx`;
            const mergedPath = path.join(MERGED_DIR, mergedName);
            fs.writeFileSync(mergedPath, outBuf);
            console.log(`✅ Merged DOCS ${pendingDocFiles.length} -> ${mergedPath}`);
            attachments.push({ path: mergedPath, filename: mergedName });
          }

          // --- Merge Partneri files (multi-sheet partner workbook) ---
          if (pendingPartnerFiles.length > 0) {
            const buffers = pendingPartnerFiles.map(p => fs.readFileSync(p));
            const mergedPartnerWb = buildMergedPartnerWorkbook(buffers, XLSX);
            const outBuf = XLSX.write(mergedPartnerWb, { bookType: 'xlsx', type: 'buffer' });
            const mergedName = `merged_partneri_${Date.now()}.xlsx`;
            const mergedPath = path.join(MERGED_DIR, mergedName);
            fs.writeFileSync(mergedPath, outBuf);
            console.log(`✅ Merged PARTNERI ${pendingPartnerFiles.length} -> ${mergedPath}`);
            attachments.push({ path: mergedPath, filename: mergedName });
          }

          // cleanup queue files
          [...pendingDocFiles, ...pendingPartnerFiles].forEach(p => {
            try { fs.unlinkSync(p); } catch {}
          });
          pendingDocFiles = [];
          pendingPartnerFiles = [];

          // email if we made anything
          if (attachments.length > 0) {
            try {
              await sendMergedEmailWithAttachments(attachments);
            } catch (e) {
              console.error('❌ Email send failed:', e);
            }
          } else {
            console.log('ℹ️ Nothing to merge; no email sent.');
          }

        } catch (err) {
          console.error('❌ Merge timer failed:', err);
        } finally {
          mergeTimer = null;
        }
      }, 60_000);
    }

    res.json({
      status: 'queued',
      queued_docs: pendingDocFiles.length,
      queued_partneri: pendingPartnerFiles.length
    });

  } catch (err) {
    console.error('merge-xlsx error:', err);
    res.status(500).json({ error: 'Failed to queue XLSX files.' });
  }
});



/* ---------- Start server ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Waybill API listening on port ${PORT}`));
