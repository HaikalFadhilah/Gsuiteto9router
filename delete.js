const http = require('http');

const ROUTER_URL = 'http://localhost:20128';
const ROUTER_PASSWORD = '123456';

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

// ==================== 9ROUTER API ====================

async function routerLogin() {
  console.log('[9Router] Login...');
  const res = await request('POST', `${ROUTER_URL}/api/auth/login`, {
    body: { password: ROUTER_PASSWORD },
  });

  if (res.status !== 200 || !res.data?.success) {
    throw new Error(`Login gagal: ${JSON.stringify(res.data)}`);
  }

  const cookie = extractAuthCookie(res.cookies);
  if (!cookie) throw new Error('Cookie auth_token tidak ditemukan');

  console.log('[9Router] ✓ Login berhasil\n');
  return cookie;
}

async function getProviders(cookie) {
  const res = await request('GET', `${ROUTER_URL}/api/providers`, { cookie });
  if (res.status !== 200) throw new Error(`Get providers gagal: ${res.status}`);
  return res.data.connections || res.data || [];
}

async function getUsage(cookie, connectionId) {
  const res = await request('GET', `${ROUTER_URL}/api/usage/${connectionId}`, { cookie });
  if (res.status !== 200) return null;
  return res.data;
}

async function deleteProvider(cookie, id) {
  const res = await request('DELETE', `${ROUTER_URL}/api/providers/${id}`, { cookie });
  return res.status === 200;
}

// ==================== DETECTION LOGIC ====================

function analyzeConnection(connection, usage) {
  const reasons = [];

  // 1. Cek error 429 (quota reached) dari connection data
  if (connection.errorCode === 429) {
    reasons.push('error 429 (quota reached)');
  }

  // 2. Cek lastError mengandung "quota"
  if (connection.lastError && connection.lastError.toLowerCase().includes('quota')) {
    reasons.push('lastError: quota reached');
  }

  // 3. Cek testStatus
  if (connection.testStatus === 'error') {
    reasons.push('testStatus: error');
  }

  // 4. Cek usage quotas — model yang 1000/1000 atau remainingPercentage = 0
  if (usage && usage.quotas) {
    const models = Object.entries(usage.quotas);
    let allExhausted = true;
    const exhaustedModels = [];

    for (const [modelId, quota] of models) {
      if (quota.unlimited) {
        allExhausted = false;
        continue;
      }

      if (quota.used >= quota.total || quota.remainingPercentage <= 0) {
        exhaustedModels.push(`${quota.displayName || modelId}: ${quota.used}/${quota.total}`);
      } else {
        allExhausted = false;
      }
    }

    if (allExhausted && models.length > 0) {
      reasons.push(`semua model habis (${exhaustedModels.length} model)`);
    } else if (exhaustedModels.length > 0) {
      // Sebagian habis — masih bisa dipakai model lain, JANGAN delete
    }
  }

  // Delete kalau: semua model habis, ATAU error 429 + quota reached
  const shouldDel = reasons.length > 0 && (
    reasons.some(r => r.includes('semua model habis')) ||
    (connection.errorCode === 429 && connection.lastError?.toLowerCase().includes('quota'))
  );

  return { shouldDelete: shouldDel, reasons };
}

function formatQuotaSummary(usage) {
  if (!usage || !usage.quotas) return 'no usage data';

  const models = Object.entries(usage.quotas);
  let exhausted = 0;
  let active = 0;

  for (const [, quota] of models) {
    if (quota.unlimited) { active++; continue; }
    if (quota.used >= quota.total || quota.remainingPercentage <= 0) {
      exhausted++;
    } else {
      active++;
    }
  }

  return `${exhausted} habis, ${active} aktif (total ${models.length} model)`;
}

// ==================== MAIN ====================

(async () => {
  try {
    const cookie = await routerLogin();

    const connections = await getProviders(cookie);
    console.log(`Total connections: ${connections.length}\n`);

    // Filter antigravity
    const agConns = connections.filter(c =>
      c.provider === 'antigravity' || c.provider === 'ag'
    );

    console.log(`Antigravity connections: ${agConns.length}`);
    if (agConns.length === 0) {
      console.log('Tidak ada Antigravity connection.');
      return;
    }

    console.log('\nScanning quota...\n');

    const toDelete = [];
    const toKeep = [];

    // Parallel fetch — 5 sekaligus biar cepat
    const BATCH = 5;
    for (let i = 0; i < agConns.length; i += BATCH) {
      const batch = agConns.slice(i, i + BATCH);

      await Promise.all(batch.map(async (conn) => {
        const name = conn.name || conn.email || conn.displayName || conn.id;

        // Fast path: kalau connection udah 429 + quota, langsung delete tanpa fetch usage
        if (conn.errorCode === 429 && conn.lastError?.toLowerCase().includes('quota')) {
          toDelete.push({ conn, reasons: ['error 429 (quota reached)'] });
          console.log(`  [✗] ${name} — HAPUS (error 429, quota reached)`);
          return;
        }

        // Kalau testStatus error, langsung delete
        if (conn.testStatus === 'error') {
          toDelete.push({ conn, reasons: ['testStatus: error'] });
          console.log(`  [✗] ${name} — HAPUS (testStatus: error)`);
          return;
        }

        // Fetch usage hanya kalau status ambiguous
        const usage = await getUsage(cookie, conn.id);
        const { shouldDelete, reasons } = analyzeConnection(conn, usage);
        const summary = formatQuotaSummary(usage);

        if (shouldDelete) {
          toDelete.push({ conn, reasons });
          console.log(`  [✗] ${name} — HAPUS (${reasons.join(', ')})`);
        } else {
          toKeep.push(conn);
          console.log(`  [✓] ${name} — KEEP (${summary})`);
        }
      }));
    }

    console.log(`\n-----------------------------------------`);
    console.log(`Hapus: ${toDelete.length} | Keep: ${toKeep.length}`);
    console.log(`-----------------------------------------\n`);

    if (toDelete.length === 0) {
      console.log('Tidak ada connection yang perlu dihapus.');
      return;
    }

    // Delete — parallel 5 sekaligus
    let deleted = 0;
    let failed = 0;

    for (let i = 0; i < toDelete.length; i += BATCH) {
      const batch = toDelete.slice(i, i + BATCH);
      await Promise.all(batch.map(async ({ conn }) => {
        const name = conn.name || conn.email || conn.displayName || conn.id;
        const ok = await deleteProvider(cookie, conn.id);
        if (ok) {
          deleted++;
          console.log(`[✓] Deleted: ${name}`);
        } else {
          failed++;
          console.log(`[✗] Failed: ${name}`);
        }
      }));
    }

    // Reset status akun yang masih ada — clear error biar balik active
    if (toKeep.length > 0) {
      console.log(`\nResetting status ${toKeep.length} akun yang masih aktif...\n`);

      await Promise.all(toKeep.map(async (conn) => {
        const name = conn.name || conn.email || conn.displayName || conn.id;

        // Clear error fields via PUT update
        const clearRes = await request('PUT', `${ROUTER_URL}/api/providers/${conn.id}`, {
          cookie,
          body: {
            testStatus: 'active',
            lastError: null,
            lastErrorAt: null,
            errorCode: null,
            backoffLevel: 0,
          },
        });

        // Trigger test biar 9router verify ulang
        const testRes = await request('POST', `${ROUTER_URL}/api/providers/${conn.id}/test`, { cookie });

        const newStatus = testRes.data?.valid ? 'active' : (testRes.data?.testStatus || '?');
        console.log(`  [↻] ${name} — status: ${newStatus}`);
      }));
    }

    console.log(`\n========================================`);
    console.log(`Selesai! Deleted: ${deleted} | Failed: ${failed} | Reset: ${toKeep.length}`);
    console.log(`========================================`);

  } catch (error) {
    console.error(`Error: ${error.message}`);
  }
})();
