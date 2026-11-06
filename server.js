const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

let latestAppCollReport = null;

const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += character;
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  const headers = (rows.shift() || []).map((value) => String(value).trim());
  return rows
    .filter((values) => values.some((value) => String(value).trim()))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
};

const pick = (row, names) => {
  const key = names.find((name) => Object.prototype.hasOwnProperty.call(row, name));
  return key ? row[key] : null;
};

const summarizeAppCollCsv = (csv) => {
  const assignments = parseCsv(csv).map((row) => {
    const openedAt = pick(row, ['OpenedOn', 'Opened On', 'Created', 'CreatedOn', 'RefDate']);
    const closedAt = pick(row, ['ClosedOn', 'Closed On', 'CompletedOn', 'FinalizedOn']);
    const start = Date.parse(openedAt);
    const end = Date.parse(closedAt);
    const turnaroundHours = Number.isFinite(start) && Number.isFinite(end) && end >= start
      ? Math.round(((end - start) / 3600000) * 10) / 10
      : null;
    return {
      id: pick(row, ['TaskID', 'Task ID', 'ID']),
      type: pick(row, ['TaskType', 'Task Type', 'Type']),
      status: pick(row, ['TaskStatus', 'Task Status', 'Status']),
      owner: pick(row, ['Owner', 'AssignedTo', 'Assigned To']),
      creator: pick(row, ['Creator', 'CreatedBy', 'Created By']),
      client: pick(row, ['Client', 'ClientName', 'Client Name']),
      matter: pick(row, ['Matter', 'MatterName', 'Matter Name']),
      document: pick(row, ['Document', 'DocumentName', 'Document Name']),
      openedAt,
      modifiedAt: pick(row, ['Modified', 'ModifiedOn', 'Modified On']),
      closedAt,
      respondBy: pick(row, ['RespondBy', 'Respond By']),
      finalDueDate: pick(row, ['FinalDueDate', 'Final Due Date']),
      turnaroundHours
    };
  });
  const completed = assignments.filter((assignment) => assignment.turnaroundHours !== null);
  return {
    matters: [],
    assignments,
    taskCount: assignments.length,
    completedTaskCount: completed.length,
    averageTurnaroundHours: completed.length
      ? Math.round((completed.reduce((sum, assignment) => sum + assignment.turnaroundHours, 0) / completed.length) * 10) / 10
      : null,
    connected: true,
    source: 'scheduled_csv',
    updatedAt: new Date().toISOString()
  };
};

app.post('/appcoll/ingest', express.text({ type: ['text/csv', 'text/plain', 'application/csv'], limit: '10mb' }), (req, res) => {
  if (!process.env.APPCOLL_INGEST_SECRET) return res.status(503).json({ error: 'AppColl ingestion is not configured' });
  if (req.headers.authorization !== `Bearer ${process.env.APPCOLL_INGEST_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    latestAppCollReport = summarizeAppCollCsv(req.body);
    return res.json({ received: true, taskCount: latestAppCollReport.taskCount, updatedAt: latestAppCollReport.updatedAt });
  } catch (error) {
    return res.status(400).json({ error: 'Invalid AppColl CSV', detail: error.message });
  }
});

app.use(express.json());

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  const body = await response.text();
  if (!response.ok) throw new Error(`Upstream request failed (${response.status}): ${body.slice(0, 200)}`);
  return body ? JSON.parse(body) : {};
};

const listAllStripeResources = async (resource, headers) => {
  const records = [];
  let startingAfter = null;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (startingAfter) query.set('starting_after', startingAfter);
    const page = await requestJson(`https://api.stripe.com/v1/${resource}?${query}`, { headers });
    const pageRecords = page.data || [];
    records.push(...pageRecords);
    startingAfter = page.has_more && pageRecords.length
      ? pageRecords[pageRecords.length - 1].id
      : null;
  } while (startingAfter);
  return records;
};

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'patent-profiler-dashboard', time: new Date().toISOString() });
});

app.get('/goplus/metrics', async (_req, res) => {
  const token = process.env.GOPLUS_API_TOKEN;
  const locationId = process.env.GOPLUS_LOCATION_ID;
  if (!token || !locationId) return res.json({ sales: [], clients: [], connected: false, reason: 'missing_credentials' });
  try {
    const base = (process.env.GOPLUS_API_BASE || 'https://services.leadconnectorhq.com').replace(/\/$/, '');
    const data = await requestJson(`${base}/opportunities/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ location_id: locationId, limit: 100 })
    });
    res.json({ sales: data.opportunities || [], clients: [], connected: true });
  } catch (error) {
    res.status(502).json({ error: 'Failed to fetch Go Plus data', detail: error.message });
  }
});

app.get('/stripe/metrics', async (_req, res) => {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return res.json({ volume: 0, currency: 'USD', paymentCount: 0, connected: false, reason: 'missing_credentials' });
  try {
    const headers = { Authorization: `Bearer ${secretKey}` };
    const charges = await listAllStripeResources('charges', headers);
    const successfulPayments = charges.filter((payment) => payment.status === 'succeeded' && payment.paid);
    const totalsByCurrency = successfulPayments.reduce((totals, payment) => {
      const currency = String(payment.currency || 'usd').toUpperCase();
      totals[currency] = (totals[currency] || 0) + (payment.amount || 0);
      return totals;
    }, {});
    const currency = totalsByCurrency.USD !== undefined
      ? 'USD'
      : Object.keys(totalsByCurrency)[0] || 'USD';
    const currentYear = new Date().getUTCFullYear();
    const currentCurrencyPayments = successfulPayments.filter(
      (payment) => String(payment.currency || 'usd').toUpperCase() === currency
    );
    const currentYearPayments = currentCurrencyPayments.filter(
      (payment) => new Date(payment.created * 1000).getUTCFullYear() === currentYear
    );
    const monthlySales = Array.from({ length: 12 }, (_, month) => ({
      month: new Date(Date.UTC(currentYear, month, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }),
      volume: currentYearPayments
        .filter((payment) => new Date(payment.created * 1000).getUTCMonth() === month)
        .reduce((sum, payment) => sum + (payment.amount || 0), 0) / 100
    }));
    res.json({
      volume: (totalsByCurrency[currency] || 0) / 100,
      currency,
      paymentCount: currentCurrencyPayments.length,
      currentYear,
      currentYearVolume: currentYearPayments.reduce((sum, payment) => sum + (payment.amount || 0), 0) / 100,
      currentYearPaymentCount: currentYearPayments.length,
      monthlySales,
      connected: true,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(502).json({ error: 'Failed to fetch Stripe data', detail: error.message });
  }
});

app.get('/lawpay/metrics', (_req, res) => {
  res.json({ revenue: 0, transactions: [], connected: false, reason: 'not_configured' });
});

app.get('/appcoll/metrics', async (_req, res) => {
  if (latestAppCollReport) return res.json(latestAppCollReport);
  if (process.env.APPCOLL_CSV_URL) {
    try {
      const response = await fetch(process.env.APPCOLL_CSV_URL);
      if (!response.ok) throw new Error(`CSV download failed (${response.status})`);
      return res.json(summarizeAppCollCsv(await response.text()));
    } catch (error) {
      return res.status(502).json({ error: 'Failed to fetch AppColl CSV', detail: error.message });
    }
  }
  const apiKey = process.env.APPCOLL_API_KEY;
  const base = (process.env.APPCOLL_API_BASE || 'https://pm.appcoll.com/api/v1').replace(/\/$/, '');
  if (!apiKey) return res.json({ matters: [], connected: false, reason: 'missing_credentials' });
  try {
    const data = await requestJson(`${base}/matters`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, 'X-API-Key': apiKey }
    });
    res.json({ matters: data.Matters || data.matters || data.data || [], connected: true, updatedAt: new Date().toISOString() });
  } catch (error) {
    res.status(502).json({ error: 'Failed to fetch AppColl data', detail: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
