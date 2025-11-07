require('dotenv').config();
const express = require('express');
const axios = require('axios');

// SOLUCIÓN: Agregar fetch para Node.js
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
globalThis.fetch = fetch;

const OpenAI = require('openai');

const app = express();
app.use(express.json());

// Inicializar OpenAI solo si se proporcionó la API key
let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: fetch });
}

// Usar IA solo si la variable lo permite y además existe la key
const USE_AI = (process.env.USE_AI === 'true') && !!process.env.OPENAI_API_KEY;

const GERMAN_PROMPT = `
PROMPT GERMAN – V2.0
Identity:
Eres German el asistente virtual de Credicard diseñado para ofrecer una experiencia bancaria segura, ágil y personalizada a través de WhatsApp. Tu identidad se construye sobre tres pilares fundamentales: eficiencia técnica, seguridad certificada y comunicación clara. Con un tono profesional pero cercano, como German guiaras a los usuarios en procesos de activación de tarjetas, consultas de saldo, compra de POS y soporte técnico, siempre dentro de los límites operativos establecidos por Credicard. Tu personalidad es metódica, no improvisas respuestas y te apegas estrictamente a los flujos validados, replicando la estructura del IVR telefónico para garantizar consistencia. Tu lenguaje es preciso: usa frases cortas, evita tecnicismos innecesarios y siempre confirma instrucciones antes de actuar. Como capa de seguridad, nunca solicitas datos sensibles y recuerda constantemente los canales oficiales para operaciones críticas. Tus límites: cuando un proceso requiere interacción humana (como la firma de contratos para POS), guía al usuario con instrucciones detalladas para culminar la gestión presencialmente. German no es solo un chatbot: eres una extensión digital de la marca Credicard, equilibrando innovación con el rigor operativo que exige la banca.
Instructions:
Formato de respuestas:
•  Máximo 1024 caracteres por mensaje (dividir en partes si es necesario).
•  Usar viñetas para listas y negritas para datos clave.
•  Mascaras permitidas para registro de clientes, alfanumérico
   J (Jurídico): J-99999999-9 
   R (Firma Personal): V-99999999 
   G (Gubernamental): G-99999999-9 
   E (Extranjero): E-99999999-9 
   V (venezolano): V-99999999 
   P (Pasaporte): P-9999999
Tono:
•  Formal pero cercano (ej: "Hemos recibido su solicitud").
•  Evitar lenguaje coloquial.
Menú principal
•  "Buen día, soy German, su asesor virtual de Credicard. Puede hablar o escribir su consulta. ¿En qué puedo ayudarle hoy? Opciones disponibles:
•  1. Tarjetas (activación, PIN, saldos) 
   Respuesta inicial: "Esta seccion aun no cuenta con servicios asociados, por lo que solo replicare posibles escenarios de conversación"
•  2. Compra de terminales POS 
•  3. Soporte técnico 
•  4. Información institucional 
Reglas seguridad
•  Tarjetahabientes: Solo gestiona: activación, recordatorio de PIN (no cambio) y consultas de saldo. Para activación: pedir últimos 4 dígitos de tarjeta más cédula.
Gestión de Voz
-  Multimodal: texto y audio (transcribe automáticamente). Confirmar comprensión de audios.
Compra de POS:
•  Recolectar: RIF, datos de contacto, tipo de POS requerido. Derivar a sede física para finalizar.
Soporte técnico:
•  Solicitar código de afiliación, número de terminal, marca, modelo/serial, descripción de la falla, teléfono. Usar imagen solo para identificar modelo. Consultar procedimientos por modelo; no diagnosticar si no existe procedimiento.
Diagnostico Nexgo G2: [procedimientos detallados…]
NEWPOS 7210/6210/8210: [procedimientos resumidos…]
NEXGO K300: [procedimientos resumidos…]
3. Información Técnica para POS (Castles Saturn 1000): [resumen técnico…]
Procesamiento de Voz: Reporte de fallas técnicas y consultas de saldo (confirmar por texto). No almacenar audios.
Seguridad y Cumplimiento: Nunca pedir claves completas, CVV, PINs o selfies.
Derivación a Agente Humano: Bloqueos de tarjeta por robo, reclamos no resueltos, fuera de menú. Mensaje: "Un asesor se contactará en menos de 24 hora al número registrado".
Gestión de Errores: Repetir menú si no entiende. Si insiste en funciones no disponibles: "Lamentamos no poder ayudarle en esta solicitud. Contacte a su banco".
Integración con Sistemas: API de saldo, base de POS, tickets.
Actualizaciones: revisar mensualmente oficinas y manuales.
`;

// Almacenamiento en memoria mejorado
const userSessions = new Map();

// Middleware para logs
app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.path}`);
  next();
});

// 1. VERIFICACIÓN DEL WEBHOOK
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('🔐 Verificando webhook...', { mode, token });
  
  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado correctamente');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Error en verificación del webhook');
    res.sendStatus(403);
  }
});

// 2. RECIBIR MENSAJES
app.post('/webhook', async (req, res) => {
  try {
    console.log('📨 Webhook recibido');
    
    if (!req.body.entry) {
      console.log('⚠️  Estructura de webhook inválida');
      return res.sendStatus(200);
    }

    const entry = req.body.entry[0];
    const changes = entry.changes[0];
    
    // Verificar si es un mensaje
    if (changes.value.messages && changes.value.messages.length > 0) {
      const message = changes.value.messages[0];
      
      if (message.type === 'text') {
        await processMessage(message);
      } else {
        console.log(`📎 Mensaje de tipo: ${message.type}`);
        await sendWhatsAppMessage(message.from, '🤖 Por ahora solo puedo procesar mensajes de texto.');
      }
    } else {
      console.log('📢 Evento de webhook (no mensaje):', changes.value.statuses ? 'status' : 'other');
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error procesando webhook:', error);
    res.sendStatus(500);
  }
});

// 3. PROCESAR MENSAJE CON IA
async function processMessage(message) {
  const userMessage = message.text.body;
  const from = message.from;
  
  console.log(`👤 ${from}: ${userMessage}`);
  
  if (!userSessions.has(from)) {
  userSessions.set(from, []);
  console.log(`🆕 Nueva sesión para: ${from}`);
  }
  
  const userSession = userSessions.get(from);
  
  userSession.push({ role: "user", content: userMessage });
  
  if (userSession.length > 12) {
    userSession.splice(0, userSession.length - 12);
  }
  
  try {
    await sendTypingIndicator(from, true);

    const aiResponse = await generateAIResponse(userSession, from);

    await sendTypingIndicator(from, false);

    userSession.push({ role: "assistant", content: aiResponse });

    await sendWhatsAppMessage(from, aiResponse);

    if (isSessionEnded(userSession)) {
      userSessions.delete(from);
    }
  } catch (error) {
    console.error('❌ Error procesando mensaje:', error);
    await sendWhatsAppMessage(from, '⚠️ Lo siento, estoy teniendo problemas técnicos. Por favor intenta más tarde.');
  }
}

function isSessionEnded(session) {
  if (!session || session.length === 0) return false;
  const lastUser = [...session].reverse().find(m => m.role === 'user');
  if (!lastUser) return false;
  const text = (lastUser.content || '').toLowerCase();
  const despedidas = [
    'gracias',
    'hasta luego',
    'nos vemos',
    'nos hablamos',
    'eso es todo',
    'adiós',
    'adios'
  ];
  return despedidas.some(p => text.includes(p));
}

function getRuleBasedResponse(conversationHistory) {
  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  const lastUser = [...history].reverse().find(m => m.role === 'user');
  const text = (lastUser?.content || '').toLowerCase();
  const hasAssistant = history.some(m => m.role === 'assistant');

  const menu = [
    'Buen día, soy German, su asesor virtual de Credicard. Puede hablar o escribir su consulta. ¿En qué puedo ayudarle hoy? Opciones:',
    '1) Tarjetas (activación, PIN, saldos)',
    '2) Compra de terminales POS',
    '3) Soporte técnico',
    '4) Información institucional'
  ].join('\n');

  // Bienvenida o volver al menú
  if (!hasAssistant || /\bmenu\b/.test(text)) {
    return menu;
  }

  // 1) Tarjetas
  if (/(^|\b)(1|tarjeta|tarjetas|pin|saldo|activaci[oó]n)(\b|$)/.test(text)) {
    const intents = [];
    if (/activaci[oó]n|activar/.test(text)) {
      intents.push(
        '*Activación de tarjeta*\n' +
        'Para activar su tarjeta, necesito:\n' +
        '- Últimos 4 dígitos de la tarjeta\n' +
        '- Número de cédula registrado\n' +
        'Ejemplo: "Activación 4578 28987654"'
      );
    }
    if (/pin|recordar/.test(text)) {
      intents.push(
        '*PIN (recordatorio)*\n' +
        'Opciones:\n' +
        '1) Cajero automático de su banco → "Recordar PIN"\n' +
        '2) App móvil de su banco → Sección "Tarjetas".\n' +
        'No podemos mostrar el PIN por este medio.'
      );
    }
    if (/saldo/.test(text)) {
      intents.push(
        '*Consulta de saldo*\n' +
        'Envíe: "Saldo 4578" (últimos 4 dígitos).\n' +
        'Mostraremos un monto aproximado; para el exacto use cajero o app bancaria.'
      );
    }
    const header = 'Esta sección aún no cuenta con servicios asociados; replicaré escenarios de conversación.';
    return [header, ...(intents.length ? intents : ['Indique si desea Activación, PIN o Saldo.']), 'Escriba "menu" para volver.'].join('\n');
  }

  // 2) Compra de terminales POS
  if (/(^|\b)(2|pos|punto de venta|terminal)(\b|$)/.test(text)) {
    return [
      'Compra de POS — Para iniciar necesito:',
      '- RIF del comercio',
      '- Nombre completo y teléfono de contacto',
      '- Tipo de POS (móvil/inalámbrico/fijo)',
      'Luego deberá completar el proceso presencialmente: "Visite nuestra oficina para finalizar la compra".',
      '¿Desea comenzar ahora o ver menú? ("menu")'
    ].join('\n');
  }

  // 3) Soporte técnico
  if (/(^|\b)(3|soporte|t[eé]cnico|falla|reparaci[oó]n)(\b|$)/.test(text)) {
    const modelHint = /nexgo|newpos|k300|verifone|pax|sunmi/.test(text)
      ? 'Nota: No mezclo modelos; cada equipo tiene su procedimiento. Si no existe procedimiento para su modelo, se lo indicaré.'
      : 'Adjunte foto del equipo si puede (solo para identificar el modelo).';
    return [
      'Soporte técnico — Para abrir un ticket, envíe:',
      '- Código de afiliación y número de terminal',
      '- Marca, modelo y serial del POS',
      '- Descripción breve de la falla',
      '- Teléfono de contacto',
      modelHint,
      '¿Desea continuar o volver al menú? ("menu")'
    ].join('\n');
  }

  // 4) Información institucional
  if (/(^|\b)(4|informaci[oó]n|institucional|empresa|credicard)(\b|$)/.test(text)) {
    return [
      'Información institucional — ¿Qué desea saber?',
      '- ¿Quién es Credicard?',
      '- CredicardPagos (POS virtual)',
      '- Adquirencia / Emisión de tarjetas',
      '- Soluciones tecnofinancieras',
      '- Oficinas y contacto',
      'Escriba "menu" para volver.'
    ].join('\n');
  }

  // Errores / fuera de tema
  if (/bloqueo|robo|perdida|p[eé]rdida/.test(text)) {
    return 'Para bloqueos por robo/pérdida, llame de inmediato al 0412-XXX-XXXX (24/7). Por seguridad, no procesamos esta solicitud por chat.';
  }

  return 'No identifiqué su solicitud. Elija una opción (1-4) o escriba "menu" para ver opciones.';
}

// 4. GENERAR RESPUESTA CON OPENAI
async function generateAIResponse(conversationHistory, userId) {
  // Si IA deshabilitada o no hay cliente de OpenAI, usar respuesta basada en reglas
  if (!USE_AI || !openai) {
    return getRuleBasedResponse(conversationHistory);
  }

  const messages = (Array.isArray(conversationHistory) ? conversationHistory : []).map(m => ({ role: m.role, content: m.content }));

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: messages,
      temperature: 0.2,
      max_tokens: 800
    });

    const text = resp.choices?.[0]?.message?.content || resp.choices?.[0]?.text || '';
    return String(text).trim() || getRuleBasedResponse(conversationHistory);
  } catch (err) {
    console.error('❌ Error llamando a OpenAI, fallback a reglas:', err?.message || err);
    return getRuleBasedResponse(conversationHistory);
  }
}

// 5. ENVIAR INDICADOR DE "ESCRIBIENDO..."
async function sendTypingIndicator(to, typing) {
  // Por ahora solo logueamos el indicador para evitar dependencias a Meta si no están configuradas.
  console.log(`✍️ Indicador de typing para ${to}: ${typing ? 'on' : 'off'}`);
}

// 6. ENVIAR MENSAJE A WHATSAPP
async function sendWhatsAppMessage(to, message) {
  // Si no están configuradas las credenciales de Meta, solo loguear
  if (!process.env.META_ACCESS_TOKEN || !process.env.META_PHONE_NUMBER_ID) {
    console.log(`(simulado) Enviar mensaje a ${to}: ${String(message || '').trim()}`);
    return { simulated: true };
  }

  const url = `https://graph.facebook.com/v18.0/${process.env.META_PHONE_NUMBER_ID}/messages`;
  const cleanMessage = String(message || '').trim();

  const data = {
    messaging_product: 'whatsapp',
    to: to,
    text: { body: cleanMessage }
  };

  try {
    const response = await axios.post(url, data, {
      headers: {
        'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    console.log('✅ Mensaje enviado correctamente');
    return response.data;

  } catch (error) {
    console.error('❌ Error enviando mensaje a WhatsApp:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });

    throw new Error(`WhatsApp API Error: ${error.response?.data?.error?.message || error.message}`);
  }
}

// 7. RUTAS ADICIONALES
app.post('/image/specs', async (req, res) => {
  try {
    const { imageBase64 } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 requerido' });

    const dataUri = imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;

    // OCR no implementado en este despliegue. Retornamos 501 Not Implemented con instrucción.
    return res.status(501).json({
      error: 'not_implemented',
      message: 'Extracción de texto de imágenes no configurada. Configure un servicio OCR o OpenAI multimodal para habilitar esta ruta.'
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Estado del bot
app.get('/', (req, res) => {
  res.json({
    status: '🟢 Bot activo',
    version: '1.0.0',
    users_activos: userSessions.size,
    sesiones_totales: Array.from(userSessions.entries()).map(([id, session]) => ({
      usuario: id,
      mensajes: session.length,
      ultima_interaccion: new Date().toISOString()
    })),
    timestamp: new Date().toISOString()
  });
});

// Limpiar sesiones
app.delete('/sessions', (req, res) => {
  const previousSize = userSessions.size;
  userSessions.clear();
  res.json({
    message: 'Sesiones limpiadas',
    sesiones_eliminadas: previousSize
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    uptime: process.uptime()
  });
});

// 8. MANEJO DE ERRORES GLOBAL
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

// 9. INICIAR SERVIDOR
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
🚀 BOT DE WHATSAPP AI INICIADO
📍 Puerto: ${PORT}
🔗 Webhook: http://localhost:${PORT}/webhook
📊 Estado: http://localhost:${PORT}/
🔧 Health: http://localhost:${PORT}/health
💾 Sesiones activas: ${userSessions.size}

⚠️  RECUERDA CONFIGURAR:
   - META_ACCESS_TOKEN
   - META_VERIFY_TOKEN  
   - META_PHONE_NUMBER_ID
   - OPENAI_API_KEY
  `);
});

// Exportar para testing
module.exports = app;