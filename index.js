const express    = require('express');
const bodyParser = require('body-parser');
const puppeteer  = require('puppeteer');
const path       = require('path');
const XLSX       = require('xlsx'); 
const app = express();
// 1) install: npm install jsdom
const { JSDOM } = require("jsdom");
const dom       = new JSDOM(`<!doctype html><html><body></body></html>`);
global.document = dom.window.document;


// at top of index.js
const fs = require('fs');
const css = fs.readFileSync(
  path.join(__dirname, 'public', 'styles.css'),
  'utf8'
);
const logoData = fs.readFileSync(
  path.join(__dirname, 'public/images/logo4.png')
).toString('base64');
const logoMime = 'image/png';

// 1) Configure Express
app.use(bodyParser.json());                           // parse JSON bodies
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));

// 2) POST endpoint to generate the waybill PDF
app.post('/api/waybill', async (req, res) => {
  try {
    const data = req.body;  // { …, products:[{description,price,discount,vat, price_includes_vat, …}, …]}

    // 1) Normalize & compute per‐item totals
    const products = (data.products || []).map(item => {
      const quantity  = item.quantity ?? 1;
      const discount  = item.discount ?? 0;
      const vat       = item.vat      ?? 21;
      const vatRate   = vat / 100;
      const price     = Number(item.price) || 0;
      // default price_includes_vat to true if missing
      const inclVat   = item.hasOwnProperty('price_includes_vat')
        ? Boolean(item.price_includes_vat)
        : true;

      // Derive the net unit price (strip VAT if included)
      const netUnitPrice = inclVat
        ? price / (1 + vatRate)
        : price;

      // Apply discount, then re-apply VAT
      const discountedNetUnit   = netUnitPrice * (1 - discount/100);
      const discountedGrossUnit = discountedNetUnit * (1 + vatRate);

      // Total for the line
      const total = Number((discountedGrossUnit * quantity).toFixed(2));

      // Decide per-item notes location
      const product_location = item.product_location?.trim()
        ? item.product_location
        : data.recieving_location;

    const description = item.description?.trim()
    ? item.description
    : 'Īpašuma vērtēšanas pakalpojumi';


      // Build displayPrice (always show the VAT-exclusive unit price)
      const displayPrice = netUnitPrice.toFixed(2);

      return {
        ...item,
        description,
        unit:            item.unit ?? 'gab',
        quantity,
        discount,
        vat,
        total,
        product_location,
        displayPrice,      // use this in the template
        netUnitPrice:      netUnitPrice.toFixed(2),
        grossUnitPrice:    discountedGrossUnit.toFixed(2),
      };
    });
    data.products = products;

    // 2) Compute summary aggregates, now using the net prices
    let sumDisc      = 0;
    let sumVatBase   = 0;
    let sumNoVatBase = 0;
    const vats       = [];

    products.forEach(item => {
      // gross net‐price total (before VAT) for this line
      const grossNet = item.netUnitPrice * item.quantity;
      // how much discount in EUR on net price
      const discAmt  = grossNet * item.discount / 100;
      // net after discount
      const netAfterDiscount = grossNet - discAmt;

      sumDisc += discAmt;
      if (item.vat === 0) {
        sumNoVatBase += netAfterDiscount;
      } else {
        sumVatBase += netAfterDiscount;
      }
      vats.push(item.vat);
    });

    const maxVat       = vats.length ? Math.max(...vats) : 0;
    const vatAmount    = sumVatBase * maxVat / 100;
    const withVatValue = sumVatBase + vatAmount;
    const totalCost    = withVatValue + sumNoVatBase;
    // 3) Number → words helpers
  function numberToWords(n) {
    if (n < 0)
        return false;

    single_digit = ['', 'viens', 'divi', 'trīs', 'četri', 'pieci', 'seši', 'septiņi', 'astoņi', 'deviņi']
    double_digit = ['desmit', 'vienpadsmit', 'divpadsmit', 'trīspadsmit', 'četrpadsmit', 'piecpadsmit', 'sešdpadsmit', 'septiņpadsmit', 'astoņpadsmit', 'deviņpadsmit']
    below_hundred = ['divdesmit', 'trīsdesmit', 'četrdesmit', 'piecdesmit', 'sešdesmit', 'septiņdesmit', 'astoņdesmit', 'deviņdesmit']

    if (n === 0) return '0';

    function translate(n) {
        let word = "";
        if (n < 10) {
            word = single_digit[n] + ' ';
        } else if (n < 20) {
            word = double_digit[n - 10] + ' ';
        } else if (n < 100) {
            let rem = translate(n % 10);
            word = below_hundred[(n - n % 10) / 10 - 2] + ' ' + rem;
        } else if (n < 1000) {
            let hundreds = Math.trunc(n / 100);
            word = single_digit[hundreds] + ' ' + (hundreds === 1 ? 'simts ' : 'simti ') + translate(n % 100);
        } else if (n < 1000000) {
            let thousands = Math.trunc(n / 1000);
            word = translate(thousands).trim() + ' ' + (thousands === 1 ? 'tūkstotis ' : 'tūkstoši ') + translate(n % 1000);
        } else {
            let millions = Math.trunc(n / 1000000);
            word = translate(millions).trim() + ' ' + (millions === 1 ? 'miljons ' : 'miljoni ') + translate(n % 1000000);
        }
        return word;
    }

    let result = translate(n);
    return result.trim() + ' ';
  }

  console.log(data);
  function capitalizeFirstLetter(s) {
      return s.charAt(0).toUpperCase() + s.slice(1);
  }


    // — Compute “today” and “today + 10” in Latvian long format
    const now = new Date();
    const due = new Date(now);
    due.setDate(now.getDate() + 10);


    const formatter = new Intl.DateTimeFormat('lv-LV', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });


    const todaysDate        = formatter.format(now).replace(/\./g, '/');; 
    const delivery_date = formatter.format(now).replace(/\./g, '/');
    const payment_date_due  = formatter.format(due).replace(/\./g, '/');



  function createAndSaveXLS(headers, data, outputDir, baseFilename) {
    // 1) Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 2) Build a 2D array for SheetJS: first row = headers, then your data rows
    const rows = Array.isArray(data[0])
      ? data                         // you passed in multiple rows
      : [ data ];                    // wrap single row into an array
    const aoa  = [ headers, ...rows ];

    // 3) Create workbook + worksheet
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, 'Noliktavas dokumenti');

    // 4) Write as .xlsx
    const filePath = path.join(outputDir, `${baseFilename}.xlsx`);
    XLSX.writeFile(wb, filePath, { bookType: 'xlsx' });

    console.log(`XLS file written to ${filePath}`);
  }


  // 2) A standalone “generateXML” that just does the XML work:
  function generateXLS(data) {
    // --- collect your filename + form data exactly as you did before ---
   

    // --- same headers array you already have ---
   const headers = [
      "Dokumenta Nr.",
      "Dokumenta Nr. (veidlapas sērija)",
      "Dokumenta datums",
      "Dokumenta tips (saīsinājums)",
      "Dokumenta veids",
      "Dokumenta valūta",
      "Dokumenta valūtas kurss",
      "Dokumenta uzņēmuma PVN maksātāja valsts",
      "Dokumenta uzņēmuma PVN numurs",
      "Dokumenta partnera nosaukums",
      "Dokumenta partnera reģ.nr./pers.kods",
      "Dokumenta partnera e-pasts",
      "Dokumenta partnera PVN maksātāja valsts",
      "Dokumenta partnera PVN numurs",
      "Dokumenta partnera kontaktpersona",
      "Dokumenta darbinieka/aģenta nosaukums",
      "Dokumenta uzņēmuma noliktavas adrese",
      "Dokumenta partnera noliktavas adrese",
      "Dokumenta PVN likme (noklusētā)",
      "Dokumenta summa",
      "Dokumenta PVN summa",
      "Dokumenta summa apmaksai",
      "Dokumenta atlaides %",
      "Dokumenta atlaides summa",
      "Dokumenta apmaksas termiņš",
      "Dokumenta apmaksas veids",
      "Dokumenta piegādes datums",
      "Dokumenta kontēšanas veidne",
      "Dokumenta kopsummu aprēķina veids",
      "Dokumenta piezīmes (papildus noteikumi)",
      // "Kokmateriālu ciršanas apliecība",
      // "Kokmateriālu pārvadātāja nosaukums",
      // "Kokmateriālu transportlīdzekļa reģ. Nr.",
      // "Kokmateriālu transportlīdzekļa vadītājs",
      // "Kokmateriālu darījuma raksturs",
      // "Kokmateriālu pakalpojuma veids",
      // "Kokmateriālu darījuma veids",
      "Dimensijas kods",
      "Dimensijas nosaukums",
      "Papildinformācijas nosaukums",
      "Papildinformācija",
      "Rindiņas preces kods",
      "Rindiņas preces svītrkods",
      // "Rindiņas preces nosaukums",
      "Rindiņas preces papildkods",
      "Rindiņas uzskaites grupa (saīsinājums)",
      "Rindiņas mērvienība",
      "Rindiņas daudzums",
      "Rindiņas cena",
      "Rindiņas cena EUR",
      "Rindiņas iepirkšanas cena",
      "Rindiņas uzskaites vērtība EUR",
      "Rindiņas atlaides %",
      "Rindiņas cena ar PVN un atlaidēm",
      "Rindiņas PVN likme",
      "Rindiņas summa apmaksai",
      "Rindiņas preces izcelsmes valsts kods",
      "Rindiņas preces KN kods",
      "Rindiņas akcīzes nodoklis",
      "Rindiņas derīguma termiņš",
      "Rindiņas sertifikāts",
      "Rindiņas noliktava (no kuras paņem preci)",
      "Rindiņas noliktava (kurā novieto preci)",
      "Rindiņas piezīmes",
      // "Rindiņas degvielas blīvums",
      // "Rindiņas degvielas sēra saturs",
      // "Rindiņas degvielas temperatūra",
      "Sastāvdaļas preces kods",
      "Sastāvdaļas preces svītrkods",
      "Sastāvdaļas preces papildkods",
      "Sastāvdaļas uzskaites grupa (saīsinājums)",
      "Sastāvdaļas mērvienība",
      "Sastāvdaļas daudzums",
      "Sastāvdaļas derīguma termiņš",
      "Sastāvdaļas sertifikāts",
      "Sastāvdaļas preces KN kods",
      "Sastāvdaļas noliktava (no kuras paņem preci)",
      "Sastāvdaļas piezīmes",
      "PVN izvērsums - apliekamā summa",
      "PVN izvērsums - PVN",
      "PVN izvērsums - PVN likme"
    ];


    const docDefaults = {
      "Dokumenta Nr.":                          "0002",
      "Dokumenta Nr. (veidlapas sērija)":       "BAL-V/GEN",
      "Dokumenta datums":                       todaysDate,
      "Dokumenta tips (saīsinājums)":           "Rēķins",
      "Dokumenta veids":                        "Standarta",
      "Dokumenta valūta":                       "EUR",
      "Dokumenta valūtas kurss":                "",
      "Dokumenta uzņēmuma PVN maksātāja valsts":  "LV",
      "Dokumenta uzņēmuma PVN numurs":          "LV40203552764",
      "Dokumenta partnera nosaukums":           data.reciever,
      "Dokumenta partnera reģ.nr./pers.kods":   data.reg_number_reciever,
      "Dokumenta partnera e-pasts":             "", //epastu pievienot
      "Dokumenta partnera PVN maksātāja valsts": "",
      "Dokumenta partnera PVN numurs":          "",
      "Dokumenta partnera kontaktpersona":      "",
      "Dokumenta darbinieka/aģenta nosaukums":   "", //agents
      "Dokumenta uzņēmuma noliktavas adrese":   "",
      "Dokumenta partnera noliktavas adrese":   data.recieving_location,
      "Dokumenta PVN likme (noklusētā)":       "21",
      "Dokumenta summa":                        sumVatBase.toFixed(2),
      "Dokumenta PVN summa":                    vatAmount.toFixed(2),
      "Dokumenta summa apmaksai":               totalCost.toFixed(2),
      "Dokumenta atlaides %":                   "",  
      "Dokumenta atlaides summa":               "0",//sumDisc.toFixed(2),
      "Dokumenta apmaksas termiņš":             payment_date_due,
      "Dokumenta apmaksas veids":               "Pārskaitījums",
      "Dokumenta piegādes datums":              todaysDate,
      "Dokumenta kontēšanas veidne":           "NĪV",//"Nekontēt",
      "Dokumenta kopsummu aprēķina veids":      "no cenas ar nodokli",
      "Dokumenta piezīmes (papildus noteikumi)": `Dokuments ir sagatavots elektroniski un derīgs bez paraksta atbilstoši "Grāmatvedības Likuma" 11.panta nosacījumiem.`,
      "Kokmateriālu darījuma raksturs":          "Pakalpojuma sniegšana", //??

      // "Kokmateriālu darījuma veids":            "Pakalpojums", //??
      // "Dimensijas kods":                        "NOT DONE",
      // "Dimensijas nosaukums":                   "NOT DONE",
      // "Papildinformācijas nosaukums":            "NOT DONE",
      // "Papildinformācija":                       "NOT DONE",
      // "Rindiņas preces kods":                       "NOT DONE",
      // "Rindiņas preces svītrkods":              "NOT DONE",
      // "Rindiņas preces papildkods":             "NOT DONE",
      "Rindiņas uzskaites grupa (saīsinājums)":   "*",
      // "Rindiņas mērvienība":                     "gab",
      // "Rindiņas daudzums":                        "1.00",
      // "Rindiņas cena":                            "NOT DONE",
      // "Rindiņas cena EUR":                        "NOT DONE",
      // "Rindiņas iepirkšanas cena":                "NOT DONE",
      // "Rindiņas uzskaites vērtība EUR":           "NOT DONE",
      "Rindiņas atlaides %":                      "0",
      // "Rindiņas cena ar PVN un atlaidēm":         "NOT DONE",
      // "Rindiņas PVN likme":                       "21.00",
      // "Rindiņas summa apmaksai":                  "NOT DONE",
      // "Rindiņas preces izcelsmes valsts kods":   "NOT DONE",
      // "Rindiņas preces KN kods":                 "NOT DONE",
      // "Rindiņas akcīzes nodoklis":               "NOT DONE",
      // "Rindiņas derīguma termiņš":               "NOT DONE",
      // "Rindiņas sertifikāts":                   "NOT DONE",
      // "Rindiņas noliktava (no kuras paņem preci)": "NOT DONE",
      // "Rindiņas noliktava (kurā novieto preci)": "NOT DONE",
      // "Rindiņas piezīmes":                     "NOT DONE",
      // "Sastāvdaļas preces kods":                 "NOT DONE",  
      // "Sastāvdaļas preces svītrkods":           "NOT DONE",
      // "Sastāvdaļas preces papildkods":          "NOT DONE",
      // "Sastāvdaļas uzskaites grupa (saīsinājums)": "NOT DONE",
      // "Sastāvdaļas mērvienība":                  "NOT DONE",
      // "Sastāvdaļas daudzums":                    "NOT DONE",
      // "Sastāvdaļas derīguma termiņš":            "NOT DONE",
      // "Sastāvdaļas sertifikāts":                "NOT DONE", 
      // "Sastāvdaļas preces KN kods":             "NOT DONE",
      // "Sastāvdaļas noliktava (no kuras paņem preci)": "NOT DONE",
      // "Sastāvdaļas piezīmes":                   "NOT DONE",
      // "PVN izvērsums - apliekamā summa": "",
      // "PVN izvērsums - PVN": "",
      // "PVN izvērsums - PVN likme": "21.00",

      "PVN izvērsums - PVN likme": "21.00",


    };
    // --- build your defaults map exactly as before ---
    // --- 4) Map each header to a default value ---
    
const rows = data.products.map(prod => {
  const quantity = Number(prod.quantity) || 1;
  const priceRaw = Number(prod.price);

  const vatRate = prod.hasOwnProperty('vat')
    ? Number(prod.vat) / 100
    : 0.21;

  const includesVat = prod.hasOwnProperty('price_includes_vat')
    ? Boolean(prod.price_includes_vat)
    : true;

  // 4) Compute net‑unit price (price without VAT)
  //    If it already includes VAT, strip it off; otherwise it is the price
  const netUnitPrice = includesVat
    ? priceRaw / (1 + vatRate)
    : priceRaw;

  // 5) Compute gross‑unit price (price with VAT)
  const grossUnitPrice = includesVat
    ? priceRaw
    : netUnitPrice * (1 + vatRate);

    // 6) Now build your rowMap using those values
    const rowMap = {
      ...docDefaults,

      // conditional code example:
      "Rindiņas preces kods": prod.description === "Ceļa izmaksas" 
                            ? "0004" 
                            : "0001",

      "Rindiņas preces nosaukums": prod.description,
      "Rindiņas mērvienība":       prod.unit       || "gab",
      "Rindiņas daudzums":         quantity,//quantity.toFixed(2),

      // PRICE fields:
      "Rindiņas cena":             netUnitPrice.toFixed(2),
      "Rindiņas cena EUR":         netUnitPrice.toFixed(2),
      "Rindiņas cena ar PVN un atlaidēm": grossUnitPrice.toFixed(2),

      // VALUE & VAT:
      // "Rindiņas uzskaites vērtība EUR": (netUnitPrice * quantity).toFixed(2),
      "Rindiņas PVN likme":          (vatRate * 100).toFixed(0),
      "Rindiņas summa apmaksai":     (grossUnitPrice * quantity).toFixed(2),

      // PVN breakdown:
      "PVN izvērsums - apliekamā summa": (netUnitPrice * quantity).toFixed(2),
      "PVN izvērsums - PVN":            ((grossUnitPrice - netUnitPrice) * quantity).toFixed(2),
      "PVN izvērsums - PVN likme":      (vatRate * 100).toFixed(0),

      // …any other fields…
    };
    // turn that map into an array in the same order as headers
    return headers.map(hdr => rowMap[hdr] ?? "");
  });


    const outputDir    = "./";
    const baseFilename = data.documentNumber || "imports_" + data.reciever;
    createAndSaveXLS(headers, rows, outputDir, baseFilename);
  }




    // 4) Build the “in-words” string
    const euros = Math.floor(totalCost);
    const cents = Math.round((totalCost - euros) * 100);
    const totalWords =
      capitalizeFirstLetter(numberToWords(euros)) + ' eiro un ' +
      capitalizeFirstLetter(numberToWords(cents)) +
      (cents === 1 ? ' cents' : ' centi');

    // 5) Pass them into EJS along with your other data
    const renderLocals = {
      ...data,
      css,
      logoData,
      logoMime,
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
      payment_date_due,
    };

    






    const html = await new Promise((resolve, reject) => {
      app.render('waybills', renderLocals, (err, str) =>
        err ? reject(err) : resolve(str)
      );
    });

    // 4) Launch headless Chrome and generate the PDF
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox']
    });
    const page    = await browser.newPage();
    
    ////////////////
    await page.emulateMediaType('print');
    ////////////////

    //////////
    await page.setViewport({
      width: 2100,             // 10px per mm → 210 mm at 96 DPI
      height: 2970,            // 297 mm at 96 DPI
      deviceScaleFactor: 1     // no Retina/2x scaling
    });
    ///////////////

    await page.setContent(html, {
        waitUntil: 'networkidle0',
        url: 'http://localhost:3000'      // or whatever your host:port is
    });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      scale: 1,
      margin:{    top:    '0mm',
    right:  '0mm',
    bottom: '0mm',
    left:   '0mm'
},
    });
    await browser.close();

    ////////////////////
    generateXLS(data); // Call the XML generation function
     ////////////////////


// 1) Get the raw receiver (fallback to “waybill” if missing)
const receiverRaw  = data.reciever?.trim() || 'waybill';

// 2) Sanitize only the truly forbidden chars
const receiverSafe = receiverRaw
  .replace(/[\/\\?%*:|"<>]/g, '_')  // replace illegal filename chars
  .trim();

// 3) Build the UTF-8 filename (with Latvian letters intact)
const utf8Name = `Rēķins_${receiverSafe}.pdf`;

// 4) Create an ASCII fallback by stripping diacritics & non-ASCII
const asciiFallback = receiverSafe
  // decompose combined letters into base + accent
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\x20-\x7E]/g, '_');

const asciiName = `Rekins_${asciiFallback}.pdf`;

// 5) Log for debugging
console.log('Generated PDF for:', utf8Name, '(ASCII fallback:', asciiName, ')');

// 6) Send it with both filename and filename*
res
  .type('application/pdf')
  .setHeader(
    'Content-Disposition',
    // ASCII first, then the UTF-8 percent-encoded name
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`
  )
  .send(pdfBuffer);

  } catch (err) {
    console.error('PDF generation error:', err);
    res.status(500).json({ error: 'Failed to generate PDF.' });
  }
});

// 6) Start listening
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Waybill API listening on port ${PORT}`));