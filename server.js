const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  const body = await response.text();
  if (!response.ok) throw new Error(`Upstream request failed (${response.status}): ${body.slice(0, 200)}`);
  return body ? JSON.parse(body) : {};
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
  if (!secretKey) return res.json({ metrics: [], clients: [], payments: [], connected: false, reason: 'missing_credentials' });
  try {
    const headers = { Authorization: `Bearer ${secretKey}` };
    const [custData, chargeData] = await Promise.all([
      requestJson('https://api.stripe.com/v1/customers?limit=100', { headers }),
      requestJson('https://api.stripe.com/v1/charges?limit=100', { headers })
    ]);
    const clients = (custData.data || []).map((customer) => ({
      id: customer.id,
      name: customer.name || customer.email || 'Unknown',
      email: customer.email || 'No email',
      status: 'active',
      spent: 0
    }));
    const payments = (chargeData.data || []).map((charge) => ({
      id: charge.id,
      amount: charge.amount / 100,
      status: charge.status,
      date: new Date(charge.created * 1000).toISOString(),
      clientName: charge.billing_details?.name || charge.billing_details?.email || 'Unknown'
    }));
    res.json({ metrics: [], clients, payments, connected: true, updatedAt: new Date().toISOString() });
  } catch (error) {
    res.status(502).json({ error: 'Failed to fetch Stripe data', detail: error.message });
  }
});

app.get('/lawpay/metrics', (_req, res) => {
  res.json({ revenue: 0, transactions: [], connected: false, reason: 'not_configured' });
});

app.get('/appcoll/metrics', async (_req, res) => {
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
