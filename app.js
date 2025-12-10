import 'dotenv/config'
import {
  createBot,
  createProvider,
  createFlow,
  addKeyword,
  EVENTS,
  MemoryDB
} from '@builderbot/bot'
import { BaileysProvider } from '@builderbot/provider-baileys'
import { toAsk, httpInject } from '@builderbot-plugins/openai-assistants'

/** Puerto en el que se ejecutará el servidor */
const PORT = process.env.PORT ?? 3008
/** ID del asistente de OpenAI (configuralo en la consola con personalidad CHAVITO) */
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? ''

/** Colas por usuario */
const userQueues = new Map()
const userLocks = new Map()

/**
 * Simular "escribiendo..." sin archivo extra
 */
const typing = async (ctx, provider) => {
  try {
    // algunos providers usan sendPresenceUpdate
    await provider.sendPresenceUpdate('composing', ctx.from)
  } catch (e) {
    console.warn('No se pudo enviar presencia de typing, pero sigo igual.')
  }
}

/**
 * Procesar mensaje del usuario con OpenAI Assistant
 */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
  await typing(ctx, provider)

  // Mensaje del usuario
  const userText = ctx.body || ''

  // Llamada al assistant (que ya tiene dentro la "personalidad Chavito")
  const response = await toAsk(ASSISTANT_ID, userText, state)

  // Cortar en párrafos y mandar uno por uno
  const chunks = String(response).split(/\n\n+/)
  for (const chunk of chunks) {
    const cleanedChunk = chunk.trim().replace(/【.*?】[ ]?/g, '')
    if (!cleanedChunk) continue
    await flowDynamic([{ body: cleanedChunk }])
  }
}

/**
 * Manejo de cola por usuario
 */
const handleQueue = async (userId) => {
  const queue = userQueues.get(userId)

  if (!queue || queue.length === 0) return
  if (userLocks.get(userId)) return

  userLocks.set(userId, true)

  try {
    while (queue.length > 0) {
      const { ctx, flowDynamic, state, provider } = queue.shift()
      await processUserMessage(ctx, { flowDynamic, state, provider })
    }
  } catch (error) {
    console.error(`Error procesando mensajes para user ${userId}:`, error)
  } finally {
    userLocks.set(userId, false)
    userQueues.delete(userId)
    userLocks.delete(userId)
  }
}

/**
 * Flujo de bienvenida estilo CHAVITO
 */
const welcomeFlow = addKeyword(BaileysProvider, MemoryDB)(EVENTS.WELCOME)
  .addAction(async (ctx, { flowDynamic }) => {
    // saludo inicial en tono Chavito
    await flowDynamic([
      {
        body:
          'Hola, soy Chavito 👋\n' +
          'Te doy una mano con las encomiendas a los penales.\n\n' +
          'Podés decirme directamente lo que necesitás.\n' +
          'Ejemplos:\n' +
          '- "Quiero mandar una caja a la unidad 28 con yerba y jabón"\n' +
          '- "Quiero saber el estado de mi pedido"\n'
      }
    ])
  })
  .addAction(async (ctx, { flowDynamic, state, provider }) => {
    const userId = ctx.from

    if (!userQueues.has(userId)) {
      userQueues.set(userId, [])
    }

    const queue = userQueues.get(userId)
    queue.push({ ctx, flowDynamic, state, provider })

    // Si es el único mensaje en la cola, arrancamos
    if (!userLocks.get(userId) && queue.length === 1) {
      await handleQueue(userId)
    }
  })

/**
 * Flujo para cualquier mensaje de texto (no solo el primero)
 * Esto hace que Chavito responda siempre, no solo en el WELCOME
 */
const anyTextFlow = addKeyword(BaileysProvider, MemoryDB)(['*'])
  .addAction(async (ctx, { flowDynamic, state, provider }) => {
    const userId = ctx.from

    if (!userQueues.has(userId)) {
      userQueues.set(userId, [])
    }

    const queue = userQueues.get(userId)
    queue.push({ ctx, flowDynamic, state, provider })

    if (!userLocks.get(userId) && queue.length === 1) {
      await handleQueue(userId)
    }
  })

/**
 * Función principal que configura e inicia el bot
 */
const main = async () => {
  const adapterFlow = createFlow([welcomeFlow, anyTextFlow])

  const adapterProvider = createProvider(BaileysProvider, {
    groupsIgnore: true,
    readStatus: false
  })

  const adapterDB = new MemoryDB()

  const { httpServer } = await createBot({
    flow: adapterFlow,
    provider: adapterProvider,
    database: adapterDB
  })

  // Esto expone el panel + QR de BuilderBot
  httpInject(adapterProvider.server)
  httpServer(+PORT)

  console.log(`🤖 CHAVITO BuilderBot arriba en puerto ${PORT}`)
}

main().catch((e) => {
  console.error('Error iniciando CHAVITO bot:', e)
})
