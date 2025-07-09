const express    = require('express');
const bodyParser = require('body-parser');
const puppeteer  = require('puppeteer');
const path       = require('path');
const app = express();


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

      // Build displayPrice (always show the VAT-exclusive unit price)
      const displayPrice = netUnitPrice.toFixed(2);

      return {
        ...item,
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

    function capitalizeFirstLetter(s) {
      return s.charAt(0).toUpperCase() + s.slice(1);
    }


    // — Compute “today” and “today + 10” in Latvian long format
    const now = new Date();
    const due = new Date(now);
    due.setDate(now.getDate() + 10);

    const dateOpts = { year: 'numeric', month: 'long', day: 'numeric' };
    const formatter = new Intl.DateTimeFormat('lv-LV', dateOpts);

    const todaysDate        = formatter.format(now); 
    const delivery_date     = todaysDate;          // same as today
    const payment_date_due  = formatter.format(due);




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
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ],
      executablePath: process.env.GOOGLE_CHROME_SHIM || '/app/.apt/google/chrome/google-chrome'
    });
    const page    = await browser.newPage();
    await page.setContent(html, {
        waitUntil: 'networkidle0',
        url: 'http://localhost:3000'      // or whatever your host:port is
    });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
   
    });
    await browser.close();


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