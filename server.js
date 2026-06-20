// server.js — Backend AllowPay PIX para Vercel
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const ALLOWPAY_BASE = 'https://allow-gi0i.onrender.com';

// ─── Gera CPF matematicamente válido ───────────────────────────────────────
function gerarCPF() {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 9));

  let s1 = 0;
  for (let i = 0; i < 9; i++) s1 += n[i] * (10 - i);
  const d1 = s1 % 11 < 2 ? 0 : 11 - (s1 % 11);

  let s2 = 0;
  for (let i = 0; i < 9; i++) s2 += n[i] * (11 - i);
  s2 += d1 * 2;
  const d2 = s2 % 11 < 2 ? 0 : 11 - (s2 % 11);

  return [...n, d1, d2].join('');
}

// ─── POST /api/pix/gerar ───────────────────────────────────────────────────
app.post('/api/pix/gerar', async (req, res) => {
  try {
    const apiKey = process.env.ALLOWPAY_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: 'Chave de API não configurada no servidor. Adicione ALLOWPAY_API_KEY nas variáveis da Vercel.'
      });
    }

    const { nome, amount } = req.body;

    if (!nome || nome.trim().split(/\s+/).length < 2) {
      return res.status(400).json({ error: 'Nome completo (nome e sobrenome) é obrigatório.' });
    }

    // Converte centavos — frontend envia centavos ou usa padrão 1937
    const amountCents = Number(amount) || 1937;

    const payload = {
      api_key: apiKey,
      amount: amountCents,
      description: 'Taxa de Validação',
      customer: {
        name: nome.trim(),
        email: `user${Date.now()}@mail.com`,
        cellphone: '11999999999',
        taxId: gerarCPF()
      }
    };

    console.log('[AllowPay] Gerando PIX para:', nome, '| Valor:', amountCents, 'centavos');

    const resp = await fetch(`${ALLOWPAY_BASE}/api/v2/allowpay-seller/create-pix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000) // 30s timeout
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('[AllowPay] Erro create-pix:', resp.status, data);
      return res.status(resp.status).json({
        error: data.error || `Erro ${resp.status} ao criar PIX. Tente novamente.`
      });
    }

    if (!data.txid || !data.pix_code) {
      console.error('[AllowPay] Resposta incompleta:', data);
      return res.status(500).json({ error: 'Resposta inválida do gateway. Tente novamente.' });
    }

    console.log('[AllowPay] PIX criado! txid:', data.txid, '| route:', data.route);

    return res.json({
      txid: data.txid,
      route: data.route,
      pix_code: data.pix_code,
      pix_qr_code: data.pix_qr_code || null
    });

  } catch (err) {
    console.error('[AllowPay] Exceção em /api/pix/gerar:', err);
    if (err.name === 'TimeoutError') {
      return res.status(504).json({ error: 'Gateway demorou demais para responder. Tente novamente.' });
    }
    return res.status(500).json({ error: 'Erro interno no servidor. Tente novamente.' });
  }
});

// ─── POST /api/pix/status ──────────────────────────────────────────────────
app.post('/api/pix/status', async (req, res) => {
  try {
    const apiKey = process.env.ALLOWPAY_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Chave de API não configurada.' });
    }

    const { txid, route } = req.body;

    if (!txid || !route) {
      return res.status(400).json({ error: 'txid e route são obrigatórios.' });
    }

    const resp = await fetch(
      `${ALLOWPAY_BASE}/api/v2/allowpay-seller/payment-status/${txid}?route=${route}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey }),
        signal: AbortSignal.timeout(15000)
      }
    );

    const data = await resp.json();

    if (!resp.ok) {
      console.error('[AllowPay] Erro payment-status:', resp.status, data);
      return res.status(resp.status).json({
        error: data.error || `Erro ${resp.status} ao consultar status.`
      });
    }

    return res.json({ status: data.status });

  } catch (err) {
    console.error('[AllowPay] Exceção em /api/pix/status:', err);
    return res.status(500).json({ error: 'Erro ao consultar status. Tente novamente.' });
  }
});

// ─── Healthcheck ───────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true }));

module.exports = app;
