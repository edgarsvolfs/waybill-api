// index.js — PDF + XML bundled into a ZIP for Make.com / Railway

const express    = require('express');
const bodyParser = require('body-parser');
const puppeteer  = require('puppeteer');
const path       = require('path');
const fs         = require('fs');
const archiver   = require('archiver');
const XLSX = require('xlsx');
const fsp = fs.promises;

const app = express();

/* ---------- Static assets ---------- */
const css = fs.readFileSync(path.join(__dirname, 'public', 'styles.css'), 'utf8');
const logoData = fs.readFileSync(path.join(__dirname, 'public/images/logo4.png')).toString('base64');
const logoMime = 'image/png';

/* ---------- Express config ---------- */
app.use(bodyParser.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));

/* ---------- Helpers ---------- */
// --- define constants first ---
const COUNTER_DIR  = process.env.COUNTER_DIR || '/data';
const COUNTER_FILE = path.join(COUNTER_DIR, 'waybill_counter.json');
const LOCK_DIR     = path.join(COUNTER_DIR, 'waybill_counter.lock');
const LOCK_FILE = path.join(COUNTER_DIR, 'waybill_counter.lock');

// --- optional: volume write probe (runs once on boot) ---
(async (dir) => {
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, '.rw-test'), `ok ${Date.now()}`, 'utf8');
    console.log('✅ Volume write OK at', dir);
  } catch (e) {
    console.error('❌ Volume write FAILED at', dir, e);
  }
})(COUNTER_DIR);

// --- locking helpers ---
// Acquire an exclusive lock by creating the file with O_EXCL.
// If the file already exists, wait, and optionally break a stale lock.
async function acquireLock({
  timeoutMs = 5000,   // how long to keep trying
  retryMs   = 50,     // backoff between tries
  staleMs   = 30000   // consider a lock stale after 30s
} = {}) {
  const start = Date.now();

  while (true) {
    try {
      const fh = await fsp.open(LOCK_FILE, 'wx'); // atomic create
      await fh.writeFile(`${process.pid}:${Date.now()}`, 'utf8');
      await fh.close();
      return; // got the lock
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // lock exists — check for staleness
      try {
        const stat = await fsp.stat(LOCK_FILE);
        const age  = Date.now() - stat.mtimeMs;
        if (age > staleMs) {
          // stale lock — remove and retry immediately
          await fsp.rm(LOCK_FILE, { force: true });
          continue;
        }
      } catch {
        // If stat/remove fails, just fall through to retry
      }

      if (Date.now() - start > timeoutMs) {
        throw new Error('Could not acquire counter lock');
      }
      await new Promise(r => setTimeout(r, retryMs));
    }
  }
}

async function releaseLock() {
  try { await fsp.rm(LOCK_FILE, { force: true }); } catch {}
}

async function releaseLock() {
  try { await fsp.rm(LOCK_DIR, { force: true }); } catch {}
}

async function ensureCounterFile() {
  try {
    await fsp.mkdir(COUNTER_DIR, { recursive: true });
    await fsp.access(COUNTER_FILE, fs.constants.F_OK);
  } catch {
    const year = new Date().getFullYear();
    await fsp.writeFile(COUNTER_FILE, JSON.stringify({ year, seq: 0 }), 'utf8');
  }
}

function formatWaybillNumber(year, seq) {
  return String(seq).padStart(4, '0');
}


async function getNextWaybillNumber() {
  await ensureCounterFile();
  await acquireLock();
  try {
    const nowYear = new Date().getFullYear();
    let state = { year: nowYear, seq: 0 };
    try {
      const raw = await fsp.readFile(COUNTER_FILE, 'utf8');
      state = JSON.parse(raw || '{}');
      if (typeof state.seq !== 'number') state.seq = 0;
      if (typeof state.year !== 'number') state.year = nowYear;
    } catch {} // use defaults

    if (state.year !== nowYear) { state.year = nowYear; state.seq = 0; }
    state.seq += 1;

    const tmp = COUNTER_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(state), 'utf8');
    await fsp.rename(tmp, COUNTER_FILE);

    return formatWaybillNumber(state.year, state.seq);
  } finally {
    await releaseLock();
  }
}


// Latvian dd.MM.yyyy
function lvDate(d = new Date()) {
  return new Intl.DateTimeFormat('lv-LV', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  }).format(d);
}

  // Build an .xlsx buffer from headers + rows
  function buildXlsxBuffer(headers, rows) {
    const wb = XLSX.utils.book_new();
    const aoa = [ headers, ...rows ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, 'Noliktavas dokumenti');
    return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
  }

// Basic LV number-to-words (from your code, lightly tidied)
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

const cap = s => (s && s[0] ? s[0].toUpperCase() + s.slice(1) : s || '');

// Build the XML string from headers + rows (first row is headers/column names)
// function buildXml(headers, rows) {
//   const esc = s => String(s ?? '')
//     .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
//     .replace(/"/g,"&quot;").replace(/'/g,"&apos;");

//   let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<Table>\n';
//   xml += '  <Headers>\n';
//   headers.forEach(h => { xml += `    <Header>${esc(h)}</Header>\n`; });
//   xml += '  </Headers>\n  <Rows>\n';
//   rows.forEach(row => {
//     xml += '    <Row>\n';
//     row.forEach((val, i) => xml += `      <Cell col="${i+1}">${esc(val)}</Cell>\n`);
//     xml += '    </Row>\n';
//   });
//   xml += '  </Rows>\n</Table>\n';
//   return xml;
// }

// Turn request body into tabular data (headers + rows) for XML
function buildTableFromBody(data, totals) {
  const {
    sumVatBase, vatAmount, totalCost, sumDisc,
    todaysDate, payment_date_due
  } = totals;

  const headers = [
    "Dokumenta Nr.","Dokumenta Nr. (veidlapas sērija)","Dokumenta datums","Dokumenta tips (saīsinājums)","Dokumenta veids",
    "Dokumenta valūta","Dokumenta valūtas kurss","Dokumenta uzņēmuma PVN maksātāja valsts","Dokumenta uzņēmuma PVN numurs",
    "Dokumenta partnera nosaukums","Dokumenta partnera reģ.nr./pers.kods","Dokumenta partnera e-pasts",
    "Dokumenta partnera PVN maksātāja valsts","Dokumenta partnera PVN numurs","Dokumenta partnera kontaktpersona",
    "Dokumenta darbinieka/aģenta nosaukums","Dokumenta uzņēmuma noliktavas adrese","Dokumenta partnera noliktavas adrese",
    "Dokumenta PVN likme (noklusētā)","Dokumenta summa","Dokumenta PVN summa","Dokumenta summa apmaksai",
    "Dokumenta atlaides %","Dokumenta atlaides summa","Dokumenta apmaksas termiņš","Dokumenta apmaksas veids",
    "Dokumenta piegādes datums","Dokumenta kontēšanas veidne","Dokumenta kopsummu aprēķina veids","Dokumenta piezīmes (papildus noteikumi)",
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

  const docDefaults = {
    "Dokumenta Nr.":                          data.documentNumber || "0000",
    "Dokumenta Nr. (veidlapas sērija)":       "BAL-V/GEN",
    "Dokumenta datums":                       todaysDate,
    "Dokumenta tips (saīsinājums)":           "Rēķins",
    "Dokumenta veids":                        "Standarta",
    "Dokumenta valūta":                       "EUR",
    "Dokumenta valūtas kurss":                "",
    "Dokumenta uzņēmuma PVN maksātāja valsts":"LV",
    "Dokumenta uzņēmuma PVN numurs":          "LV40203552764",
    "Dokumenta partnera nosaukums":           data.reciever || "",
    "Dokumenta partnera reģ.nr./pers.kods":   data.reg_number_reciever || "",
    "Dokumenta partnera e-pasts":             "",
    "Dokumenta partnera PVN maksātāja valsts":"",
    "Dokumenta partnera PVN numurs":          "",
    "Dokumenta partnera kontaktpersona":      "",
    "Dokumenta darbinieka/aģenta nosaukums":  data.agent,
    "Dokumenta uzņēmuma noliktavas adrese":   "",
    "Dokumenta partnera noliktavas adrese":   data.recieving_location || "",
    "Dokumenta PVN likme (noklusētā)":       "21",
    "Dokumenta summa":                        sumVatBase.toFixed(2),
    "Dokumenta PVN summa":                    vatAmount.toFixed(2),
    "Dokumenta summa apmaksai":               totalCost.toFixed(2),
    "Dokumenta atlaides %":                   "",
    "Dokumenta atlaides summa":               sumDisc.toFixed(2),
    "Dokumenta apmaksas termiņš":             payment_date_due,
    "Dokumenta apmaksas veids":               "Pārskaitījums",
    "Dokumenta piegādes datums":              todaysDate,
    "Dokumenta kontēšanas veidne":            "NĪV",
    "Dokumenta kopsummu aprēķina veids":      "no cenas ar nodokli",
    "Dokumenta piezīmes (papildus noteikumi)": `Dokuments ir sagatavots elektroniski un derīgs bez paraksta atbilstoši "Grāmatvedības Likuma" 11.panta nosacījumiem.`,
    "Rindiņas uzskaites grupa (saīsinājums)": "*",
    "Rindiņas atlaides %":                    "0",
    "PVN izvērsums - PVN likme":              "21"
  };

  const rows = (data.products || []).map(prod => {
    const quantity = Number(prod.quantity) || 1;
    const priceRaw = Number(prod.price) || 0;
    const vatRate  = prod.hasOwnProperty('vat') ? Number(prod.vat)/100 : 0.21;
    const includesVat = prod.hasOwnProperty('price_includes_vat')
      ? Boolean(prod.price_includes_vat)
      : true;

    const netUnit   = includesVat ? priceRaw / (1 + vatRate) : priceRaw;
    const grossUnit = includesVat ? priceRaw : netUnit * (1 + vatRate);

    const rowMap = {
      ...docDefaults,
      "Dimensijas kods": "", "Dimensijas nosaukums": "",
      "Papildinformācijas nosaukums":"", "Papildinformācija":"",
      "Rindiņas preces kods":      prod.description === "Ceļa izmaksas" ? "0004" : "0001",
      "Rindiņas preces svītrkods": "",
      "Rindiņas preces papildkods":"",
      "Rindiņas mērvienība":       prod.unit || "gab",
      "Rindiņas daudzums":         quantity,
      "Rindiņas cena":             netUnit.toFixed(2),
      "Rindiņas cena EUR":         netUnit.toFixed(2),
      "Rindiņas iepirkšanas cena": "",
      "Rindiņas uzskaites vērtība EUR": "",//(netUnit * quantity).toFixed(2),
      "Rindiņas atlaides %":       "0",
      "Rindiņas cena ar PVN un atlaidēm": grossUnit.toFixed(2),
      "Rindiņas PVN likme":         (vatRate*100).toFixed(0),
      "Rindiņas summa apmaksai":    (grossUnit * quantity).toFixed(2),
      "Rindiņas preces izcelsmes valsts kods":"", "Rindiņas preces KN kods":"",
      "Rindiņas akcīzes nodoklis":"", "Rindiņas derīguma termiņš":"",
      "Rindiņas sertifikāts":"", "Rindiņas noliktava (no kuras paņem preci)":"",
      "Rindiņas noliktava (kurā novieto preci)":"",
      "Rindiņas piezīmes":         prod.product_location || data.recieving_location || "",
      "Sastāvdaļas preces kods":"", "Sastāvdaļas preces svītrkods":"",
      "Sastāvdaļas preces papildkods":"", "Sastāvdaļas uzskaites grupa (saīsinājums)":"",
      "Sastāvdaļas mērvienība":"", "Sastāvdaļas daudzums":"",
      "Sastāvdaļas derīguma termiņš":"", "Sastāvdaļas sertifikāts":"",
      "Sastāvdaļas preces KN kods":"", "Sastāvdaļas noliktava (no kuras paņem preci)":"",
      "Sastāvdaļas piezīmes":"",
      "PVN izvērsums - apliekamā summa": (netUnit * quantity).toFixed(2),
      "PVN izvērsums - PVN":            ((grossUnit - netUnit) * quantity).toFixed(2),
      "PVN izvērsums - PVN likme":      (vatRate*100).toFixed(0)
    };

    return headers.map(h => rowMap[h] ?? "");
  });

  const baseFilename = (data.documentNumber || `Rekins__${(data.reciever||'waybill').trim()}`).toString();
  const asciiFilename = baseFilename
  .normalize("NFD")                   // split base + diacritic
  .replace(/[\u0300-\u036f]/g, "")    // remove diacritics
  .replace(/[^\x20-\x7E]/g, "_");     // replace any non-ASCII with _



  return { headers, rows, asciiFilename };
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
    const { headers, rows, baseFilename } = buildTableFromBody(data, {
      sumVatBase, vatAmount, totalCost, sumDisc, todaysDate, payment_date_due
    });

    // 1) Excel buffer
    const xlsxBuffer = buildXlsxBuffer(headers, rows);

    // 2) Ensure PDF is a Buffer (Puppeteer may give Uint8Array on some versions)
    const pdfBufferNode = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);

    // Stream a ZIP (PDF + XLSX)
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${baseFilename}.zip"`
    });

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => {
      console.error('ZIP error:', err);
      if (!res.headersSent) res.status(500).end('ZIP error');
    });
    archive.pipe(res);

    // Append both files — MUST be Buffers or Streams
    archive.append(pdfBufferNode, { name: `${baseFilename}.pdf` });
    archive.append(xlsxBuffer,   { name: `${baseFilename}.xlsx` });

    await archive.finalize();

  } catch (err) {
    console.error('Generation error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate bundle.' });
  }
});

/* ---------- Start server ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Waybill API listening on port ${PORT}`));
