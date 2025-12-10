// app.js – CHAVITO BOT con BuilderBot (TODO EN UN ARCHIVO)

require("dotenv").config();

const {
  createBot,
  createProvider,
  createFlow,
  addKeyword,
  MemoryDB,
  EVENTS,
} = require("@builderbot/bot");
const { BaileysProvider } = require("@builderbot/provider-baileys");

const axios = require("axios");
const mercadopago = require("mercadopago");
const OpenAI = require("openai");

/* =========================
 * 🧠 Clase ChatGPT modo CHAVITO
 * ========================= */
class ChatGPTChavito {
  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async procesarMensaje(mensajeUsuario, contextoExtra = {}) {
    const systemPrompt = `
Eres "Chavito", asistente para una plataforma de encomiendas a penales en Argentina.
Hablas en tono humilde, respetuoso, simple y directo.

Tu objetivo:
1. Entender si la persona quiere hacer un pedido, preguntar por estados, o solo hacer consultas.
2. Si quiere hacer un pedido, extraer:
   - penal (nombre o número)
   - nombre interno
   - productos (lista con nombre y cantidad)
   - observaciones
3. Si faltan datos, pedírselos de forma clara.
4. Responder SIEMPRE en español, tono "Chavito".
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
`;

    const userPrompt = `
Mensaje del usuario: "${mensajeUsuario}"

Contexto adicional:
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

/* =========================
 * 💸 Configuración MERCADO PAGO
 * ========================= */
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";
if (!MP_ACCESS_TOKEN) {
  console.warn("⚠️ MP_ACCESS_TOKEN no definido en .env");
}
mercadopago.configure({
  access_token: MP_ACCESS_TOKEN,
});

// Precio base por producto si todavía no usás DB real
const DEFAULT_UNIT_PRICE = Number(process.env.DEFAULT_UNIT_PRICE || 3000); // ARS

// Instancia única de ChatGPTChavito
const chatGPT = new ChatGPTChavito();

/* =========================
 * 🔧 Helper: crear preferencia MP
 * ========================= */
async function crearPreferenciaMP(pedido, from) {
  const items = [];
  let total = 0;

  for (const p of pedido.productos || []) {
    const nombre = p.nombre || "Producto";
    const cantidad = Number(p.cantidad || 1);
    const unitPrice = DEFAULT_UNIT_PRICE;

    total += unitPrice * cantidad;

    items.push({
      title: nombre,
      quantity: cantidad,
      unit_price: unitPrice,
      currency_id: "ARS",
    });
  }

  if (!items.length || !MP_ACCESS_TOKEN) {
    return { init_point: null, total: 0 };
  }

  const preference = await mercadopago.preferences.create({
    items,
    external_reference: from,
    back_urls: {
      success: "https://tu-dominio.com/pago-ok",
      failure: "https://tu-dominio.com/pago-error",
      pending: "https://tu-dominio.com/pago-pendiente",
    },
    auto_return: "approved",
  });

  return {
    init_point: preference.body.init_point,
    total,
  };
}

/* =========================
 * 🤖 Flow principal CHAVITO
 * ========================= */
const flowPrincipal = addKeyword([EVENTS.WELCOME, "hola", "buenas", "chavito"])
  .addAnswer(
    "Hola, soy Chavito 👋\nTe doy una mano con las encomiendas a los penales.\n\nPodés decirme directamente lo que necesitás.\nEjemplo:\n- \"Quiero mandar una caja a la unidad 28 con yerba y jabón\"\n- \"Quiero saber el estado de mi pedido\"",
    { capture: true },
    async (ctx, { flowDynamic }) => {
      await flowDynamic(
        "Contame en un solo mensaje: a qué penal querés mandar, para quién es y qué productos querés enviar 🙌"
      );
    }
  )
  .addAnswer(
    "Te leo 👇",
    { capture: true },
    async (ctx, { flowDynamic }) => {
      const from = ctx.from;
      const mensaje = ctx.body || "";

      const procesado = await chatGPT.procesarMensaje(mensaje, {
        origen: "whatsapp-chavito",
      });

      const respuestaTexto = procesado.respuesta_chavito;
      const pedido = procesado.pedido || {
        tipo: "consulta",
        productos: [],
      };

      await flowDynamic(respuestaTexto);

      if (pedido.tipo === "pedido" && pedido.productos.length > 0) {
        try {
          const { init_point, total } = await crearPreferenciaMP(pedido, from);

          if (!init_point) {
            await flowDynamic(
              "Te armé el pedido, pero tuve un problema con el link de pago. Más tarde lo generamos bien, quedate tranqui."
            );
            return;
          }

          await flowDynamic(
            `Perfecto 🙌\nTe armé el pedido para el penal: *${
              pedido.penal || "sin especificar"
            }*.\n` +
              `A nombre de: *${pedido.interno || "interno sin nombre"}*.\n\n` +
              `El total estimado es de *$${total}* (ARS).\n\n` +
              `Acá tenés el enlace para pagar por Mercado Pago:\n${init_point}\n\n` +
              `Apenas se acredita el pago, seguimos con el armado de la encomienda.`
          );
        } catch (err) {
          console.error("Error creando preferencia MP:", err?.message || err);
          await flowDynamic(
            "El pedido lo entendí, pero tuve un problema con Mercado Pago. Si podés, repetime más tarde o hablá con un asesor."
          );
        }
      }

      if (pedido.tipo === "estado") {
        await flowDynamic(
          "Por ahora no tengo el seguimiento conectado acá, pero pronto vas a poder ver el estado sólo con tu número de pedido 🙌."
        );
      }
    }
  );

/* =========================
 * 👤 Flow para hablar con humano
 * ========================= */
const flowHumano = addKeyword([
  "humano",
  "asesor",
  "atencion",
  "hablar con alguien",
]).addAnswer(
  "Te derivo con un asesor de Chavito para que te dé una mano directamente 🙌\nAguantame un momento, por favor.",
  null,
  async (ctx, { flowDynamic }) => {
    console.log("📲 Quiere hablar con humano:", ctx.from, ctx.body);
    await flowDynamic(
      "Listo, dejé avisado. Apenas un asesor esté libre te escribe por acá."
    );
  }
);

/* =========================
 * 🚀 MAIN BUILDERBOT
 * ========================= */
const main = async () => {
  const adapterDB = new MemoryDB();
  const adapterFlow = createFlow([flowPrincipal, flowHumano]);

  const adapterProvider = createProvider(BaileysProvider);

  // 👇 Esto levanta el servidor HTTP de BuilderBot (ahí ves el QR)
  const PORT = process.env.PORT || 3000;
  adapterProvider.initHttpServer(PORT);
  console.log(
    `✅ Servidor HTTP BuilderBot arriba en http://localhost:${PORT} (ahí ves el QR)`
  );

  await createBot({
    flow: adapterFlow,
    provider: adapterProvider,
    database: adapterDB,
  });

  console.log("🤖 Bot CHAVITO con BuilderBot iniciado y escuchando en WhatsApp.");
};

main();
