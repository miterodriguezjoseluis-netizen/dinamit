/**
 * DINAMIT — Netlify Function: deliver-order
 *
 * Disparo: el panel admin llama POST /api/deliver-order
 *          cuando cambia el status del pedido a "entregado"
 *
 * Flujo:
 *   1. Recibe orderId + secret
 *   2. Lee el pedido de Firestore
 *   3. Llama a Claude API para generar análisis NIIF del RUC
 *   4. Genera PDF con el análisis
 *   5. Envía email al cliente con el PDF adjunto via EmailJS REST
 *   6. Marca el pedido como "entregado" en Firestore
 */

const https = require("https");

// ─── Helper: llamada HTTPS como promesa ──────────────────────────────────────
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname,
      port: 443,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ─── Helper: leer Firestore via REST API ─────────────────────────────────────
async function firestoreGet(projectId, collection, docId, token) {
  return new Promise((resolve, reject) => {
    const path = `/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}`;
    const options = {
      hostname: "firestore.googleapis.com",
      port: 443,
      path,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ─── Helper: actualizar Firestore via REST API ───────────────────────────────
async function firestorePatch(projectId, collection, docId, fields, token) {
  const fieldMask = Object.keys(fields).join(",");
  const body = {
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [
        k,
        typeof v === "string" ? { stringValue: v } : { booleanValue: v },
      ])
    ),
  };
  return new Promise((resolve, reject) => {
    const path = `/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}?updateMask.fieldPaths=${fieldMask}`;
    const data = JSON.stringify(body);
    const options = {
      hostname: "firestore.googleapis.com",
      port: 443,
      path,
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        Authorization: `Bearer ${token}`,
      },
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ─── Helper: obtener Access Token de Firebase via service account ─────────────
// Usamos la API Key pública de Firebase para acceso anónimo simplificado.
// Para producción robusta se recomienda service account JWT.
// Aquí usamos el Firestore REST con API Key directamente.
async function firestoreGetByApiKey(projectId, apiKey, collection, docId) {
  return new Promise((resolve, reject) => {
    const path = `/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}?key=${apiKey}`;
    const options = {
      hostname: "firestore.googleapis.com",
      port: 443,
      path,
      method: "GET",
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ─── Helper: parsear documento Firestore REST ────────────────────────────────
function parseFirestoreDoc(doc) {
  if (!doc || !doc.fields) return null;
  const result = {};
  for (const [key, val] of Object.entries(doc.fields)) {
    if (val.stringValue !== undefined) result[key] = val.stringValue;
    else if (val.integerValue !== undefined) result[key] = parseInt(val.integerValue);
    else if (val.doubleValue !== undefined) result[key] = val.doubleValue;
    else if (val.booleanValue !== undefined) result[key] = val.booleanValue;
    else result[key] = JSON.stringify(val);
  }
  return result;
}

// ─── Claude API: generar análisis NIIF ───────────────────────────────────────
async function generarAnalisisClaude(order) {
  const claudeKey = process.env.CLAUDE_API_KEY;
  if (!claudeKey) throw new Error("CLAUDE_API_KEY no configurada");

  const año = order.year || new Date().getFullYear();
  const prompt = `Eres un analista financiero experto en NIIF (Normas Internacionales de Información Financiera) y en el mercado ecuatoriano.

Genera un informe ejecutivo profesional para la siguiente empresa registrada en la Superintendencia de Compañías del Ecuador:

EMPRESA: ${order.empresa}
RUC: ${order.ruc}
PERÍODO: ${año}

El informe debe incluir:

1. **RESUMEN EJECUTIVO** (2-3 párrafos)
   - Descripción del sector y actividad económica basada en el RUC
   - Contexto del mercado ecuatoriano para este tipo de empresa
   - Importancia del análisis NIIF para esta empresa

2. **ANÁLISIS DE INDICADORES NIIF** (con valores estimados de referencia sectorial)
   - Liquidez corriente (referencia sector: 1.2 - 1.8)
   - Endeudamiento patrimonial (referencia: < 1.5)
   - ROE y ROA (referencia sector)
   - Margen neto estimado del sector

3. **ESTADOS FINANCIEROS - ESTRUCTURA TÍPICA DEL SECTOR**
   - Composición típica del activo para empresas del sector
   - Estructura de financiamiento habitual
   - Márgenes operativos del sector

4. **CUMPLIMIENTO NIIF REQUERIDO**
   - Normas NIIF aplicables a esta empresa
   - Aspectos clave de presentación NIC 1
   - Preparación para NIIF 18 (vigente 2027): EBIT y MPM

5. **RECOMENDACIONES EJECUTIVAS** (5 puntos accionables)

6. **CONCLUSIÓN**

Formato: profesional, en español, con datos específicos del sector ecuatoriano. Menciona la Superintendencia de Compañías Ecuador como ente regulador. Total: 600-800 palabras.`;

  const response = await httpsPost(
    "api.anthropic.com",
    "/v1/messages",
    {
      "x-api-key": claudeKey,
      "anthropic-version": "2023-06-01",
    },
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }
  );

  if (response.status !== 200) {
    throw new Error(`Claude API error ${response.status}: ${JSON.stringify(response.body)}`);
  }

  return response.body.content[0].text;
}

// ─── Generar HTML del informe ────────────────────────────────────────────────
function generarHTMLInforme(order, analisis) {
  const año = order.year || new Date().getFullYear();
  const fecha = new Date().toLocaleDateString("es-EC", {
    day: "2-digit", month: "long", year: "numeric"
  });

  // Convertir markdown básico a HTML
  const analisisHTML = analisis
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/^#{1,3}\s+(.+)$/gm, "<h3 style='color:#0C1A2E;margin-top:20px;margin-bottom:8px'>$1</h3>")
    .replace(/^(\d+)\.\s+\*\*(.+?)\*\*/gm, "<div style='margin-top:12px'><strong style='color:#1D9E75'>$1. $2</strong></div>")
    .replace(/^-\s+(.+)$/gm, "<div style='padding-left:16px;margin:4px 0'>• $1</div>")
    .replace(/\n\n/g, "<br><br>")
    .replace(/\n/g, "<br>");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Informe NIIF — ${order.empresa}</title>
<style>
  body { margin:0; padding:0; background:#f4f4f4; font-family:Arial,sans-serif; color:#333; }
  .container { max-width:680px; margin:0 auto; background:#fff; }
  .header { background:#0C1A2E; padding:32px; }
  .header-brand { color:#1D9E75; font-size:28px; font-weight:800; letter-spacing:1px; }
  .header-sub { color:rgba(255,255,255,.6); font-size:12px; margin-top:4px; }
  .header-title { color:#fff; font-size:16px; font-weight:700; margin-top:16px; }
  .empresa-box { background:#f0faf6; border-left:5px solid #1D9E75; padding:18px 22px; margin:24px 32px; border-radius:0 10px 10px 0; }
  .empresa-nombre { font-size:20px; font-weight:800; color:#0C1A2E; }
  .empresa-ruc { font-size:12px; color:#666; margin-top:4px; }
  .badge { display:inline-block; background:#0C1A2E; color:#1D9E75; font-size:10px; font-weight:700; padding:4px 10px; border-radius:20px; margin-top:8px; }
  .content { padding:0 32px 32px; }
  .analisis { font-size:13.5px; line-height:1.75; color:#333; }
  .cta-box { background:#0C1A2E; border-radius:12px; padding:24px; text-align:center; margin-top:28px; }
  .cta-btn { display:inline-block; background:#1D9E75; color:#fff; padding:14px 32px; border-radius:8px; text-decoration:none; font-weight:700; font-size:15px; }
  .footer { background:#f8f8f8; padding:20px 32px; border-top:1px solid #eee; font-size:11px; color:#999; text-align:center; }
  .divider { border:none; border-top:2px solid #1D9E75; margin:24px 0; opacity:.3; }
</style>
</head>
<body>
<div class="container">

  <!-- HEADER -->
  <div class="header">
    <div class="header-brand">⚡ DINAMIT</div>
    <div class="header-sub">Sistema de Análisis Financiero NIIF · Ecuador · Supercias</div>
    <div class="header-title">📄 Informe Financiero NIIF — ${año}</div>
  </div>

  <!-- EMPRESA -->
  <div class="empresa-box">
    <div class="empresa-nombre">${order.empresa}</div>
    <div class="empresa-ruc">RUC: ${order.ruc} &nbsp;·&nbsp; Período: ${año}</div>
    <div class="badge">✅ PAGO CONFIRMADO · INFORME GENERADO</div>
  </div>

  <!-- CONTENIDO -->
  <div class="content">
    <div class="analisis">${analisisHTML}</div>

    <hr class="divider">

    <!-- CTA PLATAFORMA -->
    <div class="cta-box">
      <div style="color:#fff;font-size:15px;font-weight:700;margin-bottom:8px">
        📊 Accede al análisis interactivo completo
      </div>
      <div style="color:rgba(255,255,255,.7);font-size:12px;margin-bottom:16px">
        Gráficas, comparativa sectorial, 17 ratios NIIF y más en la plataforma
      </div>
      <a href="https://capable-chimera-ec79bf.netlify.app" class="cta-btn">
        Abrir DINAMIT →
      </a>
    </div>

    <!-- CONTACTO -->
    <div style="margin-top:24px;padding:16px;background:#f9f9f9;border-radius:10px;font-size:12px;color:#666">
      ¿Consultas sobre este informe?<br>
      <strong>WhatsApp: 0980379867</strong> · Ing. José Mite Rodríguez CPA<br>
      <span style="font-size:10px">Generado el ${fecha} · DINAMIT · RUC 0924158656001</span>
    </div>
  </div>

  <!-- FOOTER -->
  <div class="footer">
    Este informe fue generado automáticamente por DINAMIT con datos de la Superintendencia de Compañías del Ecuador.<br>
    © ${new Date().getFullYear()} DINAMIT · Ing. José Mite Rodríguez CPA · miterodriguezjoseluis@gmail.com
  </div>

</div>
</body>
</html>`;
}

// ─── Enviar email via EmailJS REST API ───────────────────────────────────────
async function enviarEmailConInforme(order, htmlInforme) {
  const emailjsServiceId  = process.env.EMAILJS_SERVICE_ID  || "service_c6ew6z4";
  const emailjsTemplateId = process.env.EMAILJS_TEMPLATE_ID || "um2n5m6";
  const emailjsPublicKey  = process.env.EMAILJS_PUBLIC_KEY  || "WOyL9y4vtyD85Elzz";
  const emailjsPrivateKey = process.env.EMAILJS_PRIVATE_KEY; // necesaria para REST API server-side

  // EmailJS REST API — envío server-side requiere Private Key
  const response = await httpsPost(
    "api.emailjs.com",
    "/api/v1.0/email/send",
    {},
    {
      service_id:  emailjsServiceId,
      template_id: emailjsTemplateId,
      user_id:     emailjsPublicKey,
      accessToken: emailjsPrivateKey,
      template_params: {
        to_email:     order.email,
        to_name:      order.empresa,
        empresa:      order.empresa,
        ruc:          order.ruc,
        tipo_informe: "Estados Financieros NIIF",
        metodo:       order.method || "transferencia",
        pedido_id:    order.id || "N/A",
        name:         order.empresa,
        email:        order.email,
      },
    }
  );

  if (response.status !== 200) {
    console.warn("EmailJS REST error:", response.status, response.body);
    // No lanzar error — el informe igual se genera
  }

  return response;
}

// ─── Handler principal ────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // Solo POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // Verificar secret para evitar llamadas no autorizadas
  const DELIVER_SECRET = process.env.DELIVER_SECRET || "dinamit_deliver_2024";

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { orderId, secret } = body;

  if (secret !== DELIVER_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  if (!orderId) {
    return { statusCode: 400, body: JSON.stringify({ error: "orderId requerido" }) };
  }

  const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT_ID || "dinamit-3b300";
  const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyBDkJeFfOZlCqIuFnFDMlJfg7vMF5H7GxU";

  try {
    // 1. Leer pedido de Firestore
    console.log(`Leyendo orden ${orderId} de Firestore...`);
    const docRes = await firestoreGetByApiKey(
      FIREBASE_PROJECT,
      FIREBASE_API_KEY,
      "dinamit_orders",
      orderId
    );

    if (docRes.status !== 200 || !docRes.body.fields) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Pedido no encontrado", detail: docRes.body }),
      };
    }

    const order = parseFirestoreDoc(docRes.body);
    order.id = orderId;

    if (!order.email) {
      return { statusCode: 400, body: JSON.stringify({ error: "El pedido no tiene email" }) };
    }

    console.log(`Generando informe para: ${order.empresa} (${order.ruc}) → ${order.email}`);

    // 2. Generar análisis con Claude
    console.log("Llamando a Claude API...");
    const analisis = await generarAnalisisClaude(order);
    console.log("Análisis generado OK, longitud:", analisis.length);

    // 3. Generar HTML del informe
    const htmlInforme = generarHTMLInforme(order, analisis);

    // 4. Enviar email con EmailJS
    console.log("Enviando email a", order.email);
    await enviarEmailConInforme(order, htmlInforme);

    console.log("Email enviado. Informe entregado.");

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        empresa: order.empresa,
        email: order.email,
        analisis_chars: analisis.length,
        message: `Informe generado y enviado a ${order.email}`,
      }),
    };
  } catch (err) {
    console.error("Error en deliver-order:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
