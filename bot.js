const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROUTER_URL = 'http://localhost:20128';
const ROUTER_PASSWORD = '123456';
const REDIRECT_URI = `${ROUTER_URL}/callback`;
const AKUN_FILE = path.join(__dirname, 'akun.txt');
const CONCURRENCY = 1;

// Auto-detect browser — cek Chrome, Edge, Brave, fallback ke Puppeteer bundled Chromium
function detectBrowser() {
  const fs = require('fs');
  const candidates = [
    // Chrome
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    // Edge
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // Brave
    `${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    // Linux/macOS
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ];

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        const name = p.includes('chrome') || p.includes('Chrome') ? 'Chrome'
          : p.includes('edge') || p.includes('Edge') ? 'Edge'
          : p.includes('rave') ? 'Brave'
          : p.includes('chromium') ? 'Chromium' : 'Browser';
        return { path: p, name };
      }
    } catch {}
  }

  // Fallback: pakai Puppeteer bundled Chromium
  return { path: null, name: 'Chromium (bundled)' };
}

// Helper: coba klik selector satu-satu, return true kalau berhasil
async function clickFirst(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        return true;
      }
    } catch {}
  }
  return false;
}

// ==================== HTTP HELPERS ====================

function request(method, urlStr, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        const cookies = res.headers['set-cookie'] || [];
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data), cookies });
        } catch {
          resolve({ status: res.statusCode, data, cookies });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function extractAuthCookie(cookies) {
  for (const c of cookies) {
    const match = c.match(/auth_token=([^;]+)/);
    if (match) return `auth_token=${match[1]}`;
  }
  return null;
}

// ==================== FILE HELPERS ====================

function readAccounts() {
  const content = fs.readFileSync(AKUN_FILE, 'utf-8').trim();
  if (!content) return [];
  return content
    .split('\n')
    .map((line) => {
      const [email, password] = line.trim().split('|');
      return { email, password, raw: line.trim() };
    })
    .filter((a) => a.email && a.password);
}

function removeAccount(rawLine) {
  const content = fs.readFileSync(AKUN_FILE, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim() !== rawLine);
  fs.writeFileSync(AKUN_FILE, lines.join('\n'));
}

// ==================== 9ROUTER API ====================

async function routerLogin() {
  console.log('[9Router] Login...');
  const res = await request('POST', `${ROUTER_URL}/api/auth/login`, {
    body: { password: ROUTER_PASSWORD },
  });

  if (res.status !== 200 || !res.data?.success) {
    throw new Error(`Login 9Router gagal: ${JSON.stringify(res.data)}`);
  }

  const cookie = extractAuthCookie(res.cookies);
  if (!cookie) {
    throw new Error('Cookie auth_token tidak ditemukan di response');
  }

  console.log('[9Router] ✓ Login berhasil');
  return cookie;
}

async function startOAuth(cookie) {
  const url = `${ROUTER_URL}/api/oauth/antigravity/authorize?redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  const res = await request('GET', url, { cookie });

  if (res.status !== 200) {
    throw new Error(`Start OAuth gagal (${res.status}): ${JSON.stringify(res.data)}`);
  }

  const { authUrl, codeVerifier, state } = res.data;
  if (!authUrl || !codeVerifier || !state) {
    throw new Error(`Response OAuth tidak lengkap: ${JSON.stringify(res.data)}`);
  }

  return { authUrl, codeVerifier, state };
}

async function exchangeToken(cookie, { code, codeVerifier, state }) {
  const res = await request('POST', `${ROUTER_URL}/api/oauth/antigravity/exchange`, {
    cookie,
    body: {
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier,
      state,
    },
  });

  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Exchange token gagal (${res.status}): ${JSON.stringify(res.data)}`);
  }

  return res.data;
}

// ==================== GOOGLE LOGIN (Headless Chrome) ====================

async function googleLogin(browser, authUrl, email, password) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  // Stealth: override navigator.webdriver dan detection properties
  await page.evaluateOnNewDocument(() => {
    // Hide webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // Fake plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });

    // Fake languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    // Override permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);

    // Hide automation-related chrome properties
    window.chrome = { runtime: {} };
  });

  try {
    let authCode = null;

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const reqUrl = req.url();

      if (reqUrl.startsWith(REDIRECT_URI)) {
        const url = new URL(reqUrl);
        authCode = url.searchParams.get('code');
        req.abort();
        return;
      }

      // Block resource berat — tapi JANGAN block stylesheet (Google butuh CSS buat render form)
      const type = req.resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        req.abort();
        return;
      }

      req.continue();
    });

    await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Kalau langsung redirect (auth code sudah didapat)
    if (authCode) {
      console.log(`  [Google] ✓ Auth code (auto-redirect)`);
      return authCode;
    }

    // Input email
    console.log(`  [Google] Email...`);
    await page.waitForSelector('#identifierId', { visible: true, timeout: 10000 });
    await page.type('#identifierId', email, { delay: 20 });

    // Tekan Enter — lebih reliable dari klik button di headless
    await sleep(500);
    await page.keyboard.press('Enter');

    // Tunggu password page load — detect perubahan URL atau element baru
    console.log(`  [Google] Password...`);
    await sleep(2000);

    // Tunggu sampai bukan di halaman identifier lagi
    let passwordReady = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const url = page.url();
      // Kalau udah pindah dari identifier page
      if (!url.includes('/identifier') || url.includes('/challenge') || url.includes('/pwd')) {
        passwordReady = true;
        break;
      }
      // Cek apakah password field udah muncul
      const pwdEl = await page.$('input[type="password"]');
      if (pwdEl) {
        passwordReady = true;
        break;
      }
      await sleep(1000);
    }

    // Input password — coba beberapa selector
    const pwdSelectors = [
      'input[type="password"][name="Passwd"]',
      'input[type="password"]',
      '#password input',
      'input[name="Passwd"]',
    ];

    let pwdField = null;
    for (const sel of pwdSelectors) {
      try {
        pwdField = await page.waitForSelector(sel, { visible: true, timeout: 5000 });
        if (pwdField) break;
      } catch {}
    }

    if (!pwdField) {
      // Debug: screenshot + URL biar tau apa yang muncul
      const debugFile = path.join(__dirname, `debug-${email.split('@')[0]}.png`);
      await page.screenshot({ path: debugFile, fullPage: true });
      const currentUrl = page.url();
      console.log(`  [DEBUG] URL: ${currentUrl}`);
      console.log(`  [DEBUG] Screenshot: ${debugFile}`);
      throw new Error('Password field tidak ditemukan — cek screenshot');
    }

    await sleep(500);
    await pwdField.type(password, { delay: 20 });

    // Tekan Enter untuk submit password
    await sleep(500);
    await page.keyboard.press('Enter');

    // Handle consent — tunggu redirect atau consent screen
    console.log(`  [Google] Consent...`);

    // Tunggu salah satu: auth code ter-capture ATAU consent button muncul
    const consentResult = await Promise.race([
      // Auth code sudah didapat dari redirect
      (async () => {
        while (!authCode) await sleep(200);
        return 'got_code';
      })(),
      // Consent screens
      (async () => {
        await sleep(2000);

        // "I understand"
        await clickFirst(page, [
          '#gaplustosNext button',
          '#gaplustosNext',
          'button::-p-text(I understand)',
        ]);
        await sleep(1500);

        // "Sign in"
        await clickFirst(page, [
          'button::-p-text(Sign in)',
          'button::-p-text(Masuk)',
        ]);
        await sleep(1500);

        // "Allow" / "Continue"
        await clickFirst(page, [
          '#submit_approve_access button',
          '#submit_approve_access',
          'button::-p-text(Allow)',
          'button::-p-text(Continue)',
          'button::-p-text(Izinkan)',
        ]);
        await sleep(1500);

        return 'consent_done';
      })(),
    ]);

    // Kalau consent selesai tapi belum dapat code, tunggu redirect
    if (!authCode) {
      const start = Date.now();
      while (!authCode && Date.now() - start < 10000) {
        await sleep(300);
      }
    }

    // Fallback: cek URL
    if (!authCode) {
      try {
        const currentUrl = page.url();
        if (currentUrl.startsWith(REDIRECT_URI)) {
          authCode = new URL(currentUrl).searchParams.get('code');
        }
      } catch {}
    }

    if (!authCode) {
      throw new Error('Auth code tidak ter-capture');
    }

    console.log(`  [Google] ✓ Auth code didapat`);
    return authCode;
  } finally {
    await page.close();
    await context.close();
  }
}

// ==================== MAIN ====================

async function loginAccount(browser, cookie, account, index, total) {
  const { email, password } = account;
  const t0 = Date.now();
  console.log(`\n[${index + 1}/${total}] ${email}`);

  console.log(`  [API] OAuth authorize...`);
  const { authUrl, codeVerifier, state } = await startOAuth(cookie);

  const authCode = await googleLogin(browser, authUrl, email, password);

  console.log(`  [API] Exchange token...`);
  const result = await exchangeToken(cookie, {
    code: authCode,
    codeVerifier,
    state,
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[✓] ${email} — ${elapsed}s (${result.connection?.id || 'OK'})`);
  removeAccount(account.raw);
}

(async () => {
  const accounts = readAccounts();
  if (accounts.length === 0) {
    console.log('Tidak ada akun di akun.txt');
    return;
  }

  console.log(`Total akun: ${accounts.length}`);

  // Auto-detect browser
  const browser_info = detectBrowser();
  console.log(`Browser: ${browser_info.name}${browser_info.path ? ` (${browser_info.path})` : ''}`);
  console.log(`Mode: API + Browser (Google OAuth only)\n`);

  // Login 9Router 1x
  const cookie = await routerLogin();

  // Launch browser — harus visible (headless kena captcha Google)
  const launchOptions = {
    headless: false,
    defaultViewport: null,
    args: [
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-translate',
      '--disable-infobars',
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  };

  // Pakai browser lokal kalau ada, fallback ke Puppeteer bundled Chromium
  if (browser_info.path) {
    launchOptions.executablePath = browser_info.path;
  }

  const browser = await puppeteer.launch(launchOptions);

  let successCount = 0;
  let failCount = 0;
  const t0 = Date.now();

  for (let i = 0; i < accounts.length; i += CONCURRENCY) {
    const batch = accounts.slice(i, i + CONCURRENCY);

    const promises = batch.map(async (account, batchIdx) => {
      try {
        await loginAccount(browser, cookie, account, i + batchIdx, accounts.length);
        successCount++;
      } catch (error) {
        console.error(`[✗] ${account.email}: ${error.message}`);
        failCount++;
      }
    });

    await Promise.all(promises);
  }

  const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n========================================`);
  console.log(`Selesai dalam ${totalTime}s`);
  console.log(`Sukses: ${successCount} | Gagal: ${failCount}`);
  console.log(`========================================`);

  // Tutup browser
  await browser.close();
  console.log('\n[Browser] ✓ Ditutup');
})();
