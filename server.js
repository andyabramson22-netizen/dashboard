const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const getAuthToken = (req) => {
  const authHeader = req.headers.authorization || '';
  return authHeader.replace('Bearer ', '').trim();
};

// --- GO PLUS ---
app.get('/goplus/metrics', async (req, res) => {
  const apiKey = getAuthToken(req);
  try {
    const response = await fetch('https://services.leadconnectorhq.com/opportunities/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ limit: 100 })
    });
    const data = await response.json();
    res.json({ sales: data.opportunities || [], clients: [] }); 
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch Go Plus data" });
  }
});

// --- STRIPE ---
app.get('/stripe/metrics', async (req, res) => {
  const secretKey = getAuthToken(req);
  try {
    const custRes = await fetch('https://api.stripe.com/v1/customers?limit=20', { headers: { Authorization: `Bearer ${secretKey}` } });
    const custData = await custRes.json();

    const subRes = await fetch('https://api.stripe.com/v1/subscriptions?limit=20', { headers: { Authorization: `Bearer ${secretKey}` } });
    const subData = await subRes.json();

    const chargeRes = await fetch('https://api.stripe.com/v1/charges?limit=20', { headers: { Authorization: `Bearer ${secretKey}` } });
    const chargeData = await chargeRes.json();

    const clients = (custData.data || []).map(c => {
      const hasSub = (subData.data || []).some(sub => sub.customer === c.id && sub.status === 'active');
      return {
        id: c.id,
        name: c.name || c.email || 'Unknown',
        email: c.email || 'No email',
        status: hasSub ? 'active' : 'inactive',
        spent: 0 
      };
    });

    const payments = (chargeData.data || []).map(p => ({
      id: p.id,
      amount: p.amount / 100,
      status: p.status,
      date: new Date(p.created * 1000).toISOString(),
      clientName: p.billing_details?.name || p.billing_details?.email || 'Unknown'
    }));

    res.json({ metrics: [], clients, payments });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch Stripe data" });
  }
});

// --- MYCASE ---
app.get('/mycase/metrics', async (req, res) => {
  const token = getAuthToken(req);
  try {
    const response = await fetch('https://api.mycase.com/v1/cases', { 
      headers: { Authorization: `Bearer ${token}` } 
    });
    const data = await response.json();
    res.json(data.cases || []); 
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch MyCase data" });
  }
});

// --- LAWPAY (via AffiniPay) ---
app.get('/lawpay/metrics', async (req, res) => {
  const secretKey = getAuthToken(req);
  try {
    // LawPay uses Basic Auth with the secret key
    const authHeader = `Basic ${Buffer.from(secretKey + ':').toString('base64')}`;
    const response = await fetch('https://api.affinipay.com/v1/charges', { 
      headers: { Authorization: authHeader } 
    });
    const data = await response.json();
    
    const transactions = (data.data || []).map(t => ({
      id: t.id,
      amount: t.amount,
      status: t.status,
      date: t.created_at,
      clientName: t.name || 'Unknown'
    }));

    res.json({ revenue: 0, transactions });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch LawPay data" });
  }
});

// --- APPCOLL ---
app.get('/appcoll/metrics', async (req, res) => {
  const apiKey = getAuthToken(req);
  try {
    const response = await fetch('https://pm.appcoll.com/api/v1/matters', { 
      headers: { Authorization: `Bearer ${apiKey}` } 
    });
    const data = await response.json();
    res.json({ matters: data.Matters || [] });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch AppColl data" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

