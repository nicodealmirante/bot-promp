// index.js – CHAVITO BOT TODO EN UN ARCHIVO

require("dotenv").config();

const {
  createBot,
  createProvider,
  createFlow,
  addKeyword,
  EVENTS,
} = require("@bot-whatsapp/bot");
const QRPortalWeb = require("@bot-whatsapp/portal");
const BaileysProvider = require("@bot-whatsapp/provider/baileys");
const MockAdapter = require("@bot-whatsapp/database/mock");

const axios = require("axios");

// =========================
// 🧠 Clase ChatGPT modo CHAVITO
// =========================
class ChatGPTChavito {
  constructor() {
    const OpenAI = require("openai");
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  /**
   * Recibe el mensaje libre del usuario y devuelve:
   * - texto-respuesta estilo CHAVITO
   * - un JSON de pedido interpretado (si hay datos suficientes)
   */
  async procesarMensaje(mensajeUsuario, contextoExtra = {}) {
    const systemPrompt = `
Eres "Chavito", asistente para una plataforma de encomiendas a penales en Argentina.
Hablas en tono humilde, respetuoso, simple y directo.
Siempre priorizas claridad y pasos concretos.

Tu objetivo:
1. Entender si la persona quiere hacer un pedido, preguntar por estados, o solo hacer consultas.
2. Si quiere hacer un pedido, extraer:
   - penal (nombre o número)
   - nombre interno
   - productos (lista con nombre y cantidad)
   - observaciones
3. Si faltan datos, pedírselos de forma clara.
4. Responder SIEMPRE en español, tono "Chavito":
   - Ej: "Hola, soy Chavito. Te doy una mano con tu pedido."
   - Lenguaje simple, directo, sin tecnicismos.
5. Si puedes estructurar un pedido, genera un JSON con esta forma:
   {
     "tipo": "pedido" | "estado" | "consulta",
     "penal": "string o null",
     "interno": "string o null",
     "productos": [
       { "nombre": "string", "cantidad": number }
     ],
     "observaciones": "string o null"
   }

Responde SIEMPRE en formato JSON con la forma:
{
  "respuesta_chavito": "texto que va a leer el usuario",
  "pedido": {
    "tipo": "...",
    "penal": "...",
    "interno": "...",
    "productos": [...],
    "observaciones": "..."
  }
}

Si no hay suficiente información para armar el pedido, pon "productos": [] y deja claro en "respuesta_chavito" qué falta preguntar.
`;

    const userPrompt = `
Mensaje del usuario: "${mensajeUsuario}"

Contexto adicional (puede estar vacío):
${JSON.stringify(contextoExtra, null, 2)}
`;

    try {
      const completion = await this.client.chat.completions.create({
        model: "gpt-4.1-mini",
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });

      const raw = completion.choices[0].message.content;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        parsed = {
          respuesta_chavito:
            "Te doy una mano, pero no entendí bien tu mensaje. ¿Me contás a qué penal querés mandar y qué productos?",
          pedido: {
            tipo: "consulta",
            penal: null,
            interno: null,
            productos: [],
            observaciones: null,
          },
        };
      }
      return parsed;
    } catch (err) {
      console.error("Error ChatGPT:", err?.message || err);
      return {
        respuesta_chavito:
          "Estoy con un problemita para pensar ahora, pero igual te puedo ayudar. Decime despacio a qué penal querés mandar y qué productos.",
        pedido: {
          tipo: "consulta",
          penal: null,
          interno: null,
          productos: [],
          observaciones: null,
        },
      };
    }
  }
}

// =========================
// 🔧 Configuración CHAVITO
// =========================
const CHAVITO_BACKEND_URL =
  process.env.CHAVITO_BACKEND_URL ||
  "https://backend-chh-production.up.railway.app";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";

// Instancia única de ChatGPTChavito
const chatGPT = new ChatGPTChavito();

// =========================
// 🌐 Helpers para backend
// =========================

async function crearPedidoEnBackend(pedidoEstructurado, from) {
  try {
    const url = `${CHAVITO_BACKEND_URL}/api/whatsapp/pedidos`;

    const resp = await axios.post(url, {
      whatsapp: from,
      tipo: pedidoEstructurado.tipo,
      penal: pedidoEstructurado.penal,
      interno: pedidoEstructurado.interno,
      productos: pedidoEstructurado.productos,
      observaciones: pedidoEstructurado.observaciones,
    });

    return resp.data; // se espera algo como { ok: true, pedidoId, mp_link }
  } catch (err) {
    console.error("Error creando pedido en backend:", err?.message || err);
    return null;
  }
}

async function consultarEstadoPedido(from) {
  try {
    const url = `${CHAVITO_BACKEND_URL}/api/whatsapp/pedidos/estado`;
    const resp = await axios.get(url, {
      params: { whatsapp: from },
    });
    return resp.data; // ejemplo: { ok: true, pedidos: [...] }
  } catch (err) {
    console.error("Error consultando estado:", err?.message || err);
    return null;
  }
}

// =========================
// 🤖 Flow principal CHAVITO
// =========================

const flowPrincipal = addKeyword([EVENTS.WELCOME, "hola", "buenas"])
  .addAnswer(
    "Hola, soy Chavito 👋\nTe doy una mano con las encomiendas a los penales.\n\nPodés decirme directamente lo que necesitás.\nEjemplo:\n- \"Quiero mandar una caja a la unidad 28 con yerba y jabón\"\n- \"Quiero saber el estado de mi pedido\"",
    { capture: true },
    async (ctx, { flowDynamic }) => {
      // El siguiente mensaje del usuario ya entra directo al flujo inteligente
      await flowDynamic(
        "Contame: ¿a qué penal querés mandar y qué productos querés enviar?"
      );
    }
  )
  .addAnswer(
    "Escribime en un solo mensaje así lo entiendo mejor 🙌",
    { capture: true },
    async (ctx, { flowDynamic }) => {
      const from = ctx.from;
      const mensaje = ctx.body || "";

      // Enviar mensaje a ChatGPT modo CHAVITO
      const procesado = await chatGPT.procesarMensaje(mensaje, {
        origen: "flowPrincipal",
      });

      const respuestaTexto = procesado.respuesta_chavito;
      const pedido = procesado.pedido || {
        tipo: "consulta",
        productos: [],
      };

      await flowDynamic(respuestaTexto);

      // Si ChatGPT detecta que es un pedido
      if (pedido.tipo === "pedido" && pedido.productos.length > 0) {
        const creado = await crearPedidoEnBackend(pedido, from);

        if (!creado || !creado.ok) {
          await flowDynamic(
            "Voy a tener que cargarlo a mano, tuve un problema técnico. Pero quedate tranqui, repetime por favor el mensaje con penal, interno y productos."
          );
          return;
        }

        // Se asume que el backend devuelve mp_link o similar
        if (creado.mp_link) {
          await flowDynamic(
            `Perfecto 🙌\nTe armé el pedido N° ${creado.pedidoId}.\nAcá tenés el enlace para pagar por Mercado Pago:\n${creado.mp_link}\n\nApenas se acredita el pago, ponemos el pedido en PREPARANDO y te avisamos.`
          );
        } else {
          await flowDynamic(
            `Perfecto 🙌\nTe armé el pedido N° ${creado.pedidoId}.\nCuando esté listo el pago, te avisamos por acá.`
          );
        }
      }

      // Si sólo consultó estado
      if (pedido.tipo === "estado") {
        const estado = await consultarEstadoPedido(from);

        if (!estado || !estado.ok || !estado.pedidos?.length) {
          await flowDynamic(
            "Por ahora no encuentro pedidos recientes a tu nombre. Si ya hiciste uno, mandame el número de pedido o el comprobante y te ayudo."
          );
          return;
        }

        const ult = estado.pedidos[0];
        await flowDynamic(
          `Te cuento el último pedido que tengo:\n\n` +
            `🧾 Pedido N° ${ult.id}\n` +
            `📍 Penal: ${ult.penal}\n` +
            `👤 Interno: ${ult.interno}\n` +
            `📦 Estado actual: ${ult.estado}\n\n` +
            `Si querés más info, te puedo pasar el detalle.`
        );
      }
    }
  );

// =========================
// 💬 Flow para consultas cortas tipo "estado"
// =========================

const flowEstado = addKeyword(["estado", "seguimiento", "tracking"])
  .addAnswer(
    "Dale, te ayudo con el estado de tu pedido 🙌",
    null,
    async (ctx, { flowDynamic }) => {
      const from = ctx.from;
      const estado = await consultarEstadoPedido(from);

      if (!estado || !estado.ok || !estado.pedidos?.length) {
        await flowDynamic(
          "Por ahora no tengo pedidos recientes con tu número. Si ya hiciste uno, mandame el número de pedido o el comprobante."
        );
        return;
      }

      let texto = "Estos son tus últimos pedidos:\n\n";
      estado.pedidos.slice(0, 3).forEach((p) => {
        texto += `🧾 Pedido N° ${p.id} – Estado: ${p.estado}\n`;
      });

      await flowDynamic(texto);
    }
  );

// =========================
// 👤 Flow para derivar a humano
// =========================

const flowAgente = addKeyword(["hablar con alguien", "humano", "asesor"])
  .addAnswer(
    "Te derivo con un asesor de Chavito para que te dé una mano directamente 🙌\nAguantame un momento, por favor.",
    null,
    async (ctx, { flowDynamic }) => {
      // Acá podrías pegarle a tu backend para marcar "requiere agente"
      try {
        await axios.post(
          `${CHAVITO_BACKEND_URL}/api/whatsapp/derivar`,
          {
            whatsapp: ctx.from,
            mensaje: ctx.body,
          }
        );
      } catch (err) {
        console.error("Error derivando a agente:", err?.message || err);
      }
      await flowDynamic(
        "Listo, dejé avisado. Apenas un asesor esté libre te escribe por acá."
      );
    }
  );

// =========================
// 🚀 Main
// =========================

const main = async () => {
  const adapterDB = new MockAdapter();

  const adapterFlow = createFlow([flowPrincipal, flowEstado, flowAgente]);

  const adapterProvider = createProvider(BaileysProvider);

  createBot({
    flow: adapterFlow,
    provider: adapterProvider,
    database: adapterDB,
  });

  QRPortalWeb({
    name: "CHAVITO – Encomiendas a Penales",
    port: process.env.PORT || 3000,
  });

  console.log("🤖 Bot CHAVITO iniciado y escuchando en WhatsApp.");
};

main();
