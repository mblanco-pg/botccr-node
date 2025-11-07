require('dotenv').config();
const express = require('express');
const axios = require('axios');

// SOLUCIÓN: Agregar fetch para Node.js
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
globalThis.fetch = fetch;

const OpenAI = require('openai');
const sharp = require('sharp');

const app = express();
app.use(express.json());

// Inicializar OpenAI solo si se proporcionó la API key
let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: fetch });
}

// 10. PROCESAR IMAGENES (sin almacenar en servidor)
async function processImageMessage(message) {
  const from = message.from;
  const imageObj = message.image || {};
  const mediaId = imageObj.id || imageObj[0]?.id;

  console.log(`🖼️ Imagen recibida de ${from}, mediaId=${mediaId}`);

  if (!userSessions.has(from)) {
    userSessions.set(from, { messages: [], lastActivity: Date.now(), timeout: null });
    console.log(`🆕 Nueva sesión (imagen) para: ${from}`);
  }

  const sessionObj = userSessions.get(from);
  sessionObj.lastActivity = Date.now();
  if (sessionObj.messages.length > 12) sessionObj.messages.splice(0, sessionObj.messages.length - 12);
  scheduleSessionCleanup(from);

  if (!mediaId) {
    await sendWhatsAppMessage(from, '⚠️ No pude identificar la imagen enviada.');
    return;
  }

  try {
    const token = process.env.META_ACCESS_TOKEN;
    if (!token) {
      console.log('⚠️ META_ACCESS_TOKEN no configurado — no se puede descargar media');
      await sendWhatsAppMessage(from, '⚠️ El servidor no está autorizado para descargar la imagen.');
      return;
    }

    // Obtener metadata del media para conseguir la URL
    const metaResp = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, { params: { access_token: token } });
    const mediaUrl = metaResp.data?.url || metaResp.data?.file_url || metaResp.data?.uri;
    if (!mediaUrl) {
      console.error('❌ No se obtuvo URL del media:', metaResp.data);
      await sendWhatsAppMessage(from, '⚠️ No pude obtener la URL del archivo enviado.');
      return;
    }

    // Descargar en memoria
    const dlResp = await axios.get(mediaUrl, { responseType: 'arraybuffer', headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
    const buffer = Buffer.from(dlResp.data);
    const contentType = dlResp.headers['content-type'] || 'image/jpeg';
    console.log(`⬇️ Imagen descargada (${buffer.length} bytes)`);

    // Procesar imagen en memoria (resize/compress)
    const maxWidth = Number(process.env.IMAGE_MAX_WIDTH) || 1024;
    const quality = Number(process.env.IMAGE_QUALITY) || 80;
    let processedBuffer = buffer;
    try {
      processedBuffer = await sharp(buffer).resize({ width: maxWidth, withoutEnlargement: true }).jpeg({ quality }).toBuffer();
      console.log(`🔧 Imagen procesada en memoria: ${buffer.length} -> ${processedBuffer.length} bytes`);
    } catch (e) {
      console.warn('⚠️ sharp falló, usando buffer original:', e?.message || e);
      processedBuffer = buffer;
    }

    // Construir data URL y llamar a OpenAI Responses vía JSON
    if (!process.env.OPENAI_API_KEY) {
      console.log('⚠️ OPENAI_API_KEY no configurado — no se puede procesar la imagen con OpenAI');
      await sendWhatsAppMessage(from, '⚠️ No está configurada la clave de OpenAI para procesar imágenes.');
      return;
    }

    const imageBase64 = processedBuffer.toString('base64');
    const dataUrl = `data:${contentType};base64,${imageBase64}`;
    const systemPrompt = GERMAN_PROMPT + '\n\nInstrucción: Analiza la imagen adjunta y extrae la información relevante para el flujo bancario. Responde con un breve resumen y, si aplica, un JSON estructurado.';

    const payload = {
      model: process.env.OPENAI_IMAGE_MODEL || 'gpt-4o-mini-vision',
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Analiza la siguiente imagen y extrae la información: ${dataUrl}` }
      ]
    };

    const resp = await axios.post('https://api.openai.com/v1/responses', payload, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      maxBodyLength: Infinity,
      timeout: 60000
    });

    const extractedText = resp.data?.output_text || resp.data?.output?.[0]?.content?.[0]?.text || JSON.stringify(resp.data);

    // Guardar en sesión y enviar mensaje
    sessionObj.messages.push({ role: 'user', content: '[imagen]'});
    sessionObj.messages.push({ role: 'assistant', content: extractedText });
    sessionObj.lastActivity = Date.now();
    scheduleSessionCleanup(from);

    await sendWhatsAppMessage(from, `🖼️ Resultado de la imagen:\n${String(extractedText).slice(0,1500)}`);

  } catch (err) {
    console.error('❌ Error procesando imagen:', err?.response?.data || err.message || err);
    await sendWhatsAppMessage(from, '⚠️ Ocurrió un error al procesar la imagen. Intente nuevamente.');
  }
}

// Usar IA solo si la variable lo permite y además existe la key
const USE_AI = (process.env.USE_AI === 'true') && !!process.env.OPENAI_API_KEY;

const GERMAN_PROMPT = `
PROMPT GERMAN – V2.0
Identity:
Eres German el asistente virtual de Credicard diseñado para ofrecer una experiencia bancaria segura, ágil y personalizada a través de WhatsApp. Tu identidad se construye sobre tres pilares fundamentales: eficiencia técnica, seguridad certificada y comunicación clara. Con un tono profesional pero cercano, como German guiaras a los usuarios en procesos de activación de tarjetas, consultas de saldo, compra de POS y soporte técnico, siempre dentro de los límites operativos establecidos por Credicard. Tu personalidad es metódica, no improvisas respuestas y te apegas estrictamente a los flujos validados, replicando la estructura del IVR telefónico para garantizar consistencia. Tu lenguaje es preciso: usa frases cortas, evita tecnicismos innecesarios y siempre confirma instrucciones antes de actuar. Como capa de seguridad, nunca solicitas datos sensibles y recuerda constantemente los canales oficiales para operaciones críticas. Tus límites: cuando un proceso requiere interacción humana (como la firma de contratos para POS), guía al usuario con instrucciones detalladas para culminar la gestión presencialmente. German no es solo un chatbot: eres una extensión digital de la marca Credicard, equilibrando innovación con el rigor operativo que exige la banca.
Instructions:
Formato de respuestas:
•	Máximo 1024 caracteres por mensaje (dividir en partes si es necesario).
•	Usar viñetas para listas y negritas para datos clave.
•	Mascaras permitidas para registro de clientes, alfanumérico
o	J (Jurídico): J-99999999-9 
o	R (Firma Personal): V-99999999 
o	G (Gubernamental): G-99999999-9 
o	E (Extranjero): E-99999999-9 
o	V (venezolano): V-99999999 
o	P (Pasaporte): P-9999999
Tono:
•	Formal pero cercano (ej: "Hemos recibido su solicitud" en lugar de "Recibí tu pedido").
•	Evitar lenguaje coloquial.
Menú principal
•	*"Buen día, soy German, su asesor virtual de Credicard. Puede hablar o escribir su consulta. ¿En qué puedo ayudarle hoy? Opciones disponibles: *
•	1. *Tarjetas (activación, PIN, saldos) *  
o	Para esta sección debes responder de manera inical con este mensaje: *Esta seccion aun no cuenta con servicios asociados, por lo que solo replicare posibles escenarios de conversación*
•	2. *Compra de terminales POS*  
•	3. *Soporte técnico*  
•	4. *Información institucional*  
Reglas seguridad
•	Tarjetahabientes:
o	Solo gestiona: activación, recordatorio de PIN (no cambio) y consultas de saldo.
o	Para activación: pedir últimos 4 dígitos de tarjeta más cédula.
Gestión de Voz
-	**Multimodal**: Procesa texto y audio (transcribe automáticamente)
-	**Reconocimiento vocal**: Interpreta solicitudes habladas
-	**Confirmación**: Siempre verifica comprensión de audios
-	**Tolerancia a ruido**: Filtra sonidos ambientales en mensajes de voz
-	*Al detectar voz*:  
o	*"Gracias por su mensaje. Estoy procesando su solicitud..."* (mientras transcribe)
-	*Si el audio no es claro*:  
o	*"Disculpé, no pude entender completamente. ¿Podría repetirlo o escribirlo? Le muestro las opciones nuevamente: [repite menú]"*
Compra de POS:
•	Recolectar: RIF, datos de contacto, tipo de POS requerido.
•	Derivar a sede física con mensaje: "Visite nuestra oficina en [dirección] para finalizar la compra".
Soporte técnico:
•	Solicitar código de afiliación antes de recolectar los datos del POS
•	Solicitar número de terminal
•	Solicitar: marca, modelo/serial del POS, descripción escrita de la falla, teléfono de contacto.
•	Si el usuario envía imagen: usarla solo para identificar el modelo, no para diagnóstico.
•	A partir del modelo consulta las posibles soluciones para la falla que se presenta
Diagnósticos:
Diagnostico Nexgo G2:
El equipo debe de estar en la pantalla principal. Una vez ubicados en la pantalla principal, se procede a apagar el POS y realizamos los siguientes pasos:
•	Encender el equipo: Presionar los siguientes tres botones a la vez sin soltarlos hasta visualizar la pantalla azul.
•	Contraseña de acceso: 83890345.
•	Ingresar la contraseña. El equipo preguntará si está seguro de borrar la app. Confirmar con "Sí".
•	Nota: Realizar hasta este paso.
o	Anotar los datos del cliente y del punto para el envío de parámetros.
o	Dejar el equipo encendido en la pantalla azul.
•	El equipo esperará la APP. El cliente debe notificar para enviar la app de manera remota.
•	Opción alternativa (Paso 2 – Descarga de la APP):
o	Seleccionar la opción 2 WIFI y elegir la red correspondiente.
o	Importante: Solo puede estar conectado a WiFi.
•	Seleccionar la red WiFi e ingresar la contraseña.
•	Presionar el botón verde y luego la opción 1.
•	Confirmar la conexión exitosa del POS.
•	Presionar el botón rojo dos veces para avanzar.
•	Salir del menú:
o	Presionar "Cancelar" una vez.
o	Cuando pregunte si desea salir, confirmar con el botón verde.
•	Al aparecer la pantalla, presionar el botón de Cancelar (X).
•	Seleccionar la opción 1: ONLINE REPORT.
•	El equipo cargará los parámetros. Esperar a que finalice.
•	Al terminar, el equipo estará actualizado.
•	Ingresar con la contraseña: 43716352020.
•	Tras ingresar, el equipo realizará un cierre.
•	Reiniciar el equipo y al encender, ingresar con el RIF del cliente.
•	Verificar:
o	Hora y fecha actualizadas (si no, mostrará "Llaves inválidas").
o	Si la hora está desactualizada, ir a: Manuales > Nexgo G2 > Hora y Fecha.
•	Realizar una transacción para validar que no aparezca "Comercio Inválido".

NEWPOS 7210/6210/8210
Gerencia de Operaciones Integrales de Adquiriencia
•	Impresora
•	Botón de encendido y apagado
•	CONECTOR DE CARGA
•	Banda | CHIP
•	Lector de tarjeta CHIP
•	MemoryTech® | Linux
Inicialización de POS
1.	Encender el equipo y llegar a la pantalla principal.
2.	Presionar la tecla verde "Enter" e ingresar el RIF del comercio para desbloquearlo.
CONEXIÓN WIFI
1.	Presionar "MENU" > "ADMINISTRACION" (Opción #2).
2.	Seleccionar "Config. Comunicación" (Opción #7).
3.	Elegir "WIFI" (Opción #1) y seleccionar la red disponible.
INSERCIÓN DE SIM CARD
1.	Retirar la tapa posterior del POS.
2.	Insertar la SIM en la ranura SIM 1.
3.	Reiniciar el equipo (apagar/encender).
Nota:
•	Modelos compatibles: ADOPTED, Orange SIME, Color POSE.
CONEXIÓN GPRS
1.	Ir a "Administración" (Opción #2) > "Config. Comunicación" (Opción #7).
2.	Seleccionar "Red Móvil" (Opción #2) y configurar APN según la operadora (Digital/Movistar).
TEST DE COMUNICACIÓN
1.	Ir a "Menú" > "Administración" (Opción #2) > "Test Comunicación" (Opción #6).
REALIZAR UNA COMPRA
1.	Presionar el botón verde "Enter" o ir a "Menú" > "Operaciones" (Opción #1) > "Compra" (Opción #1).
2.	Ingresar monto y datos de la tarjeta.
CIERRE DE LOTE
1.	Ir a "Menú" > "Administración" (Opción #2) > "Cierre de Lote" (Opción #5).
Continuación de procedimientos para otros modelos (Nexgo, PAX, SUNMI, etc.):
•	Inicialización: Similar a pasos anteriores, con claves específicas por modelo.
•	Configuración WIFI/GPRS: Detalles técnicos para cada dispositivo.
•	Test de comunicación: Opciones en menús técnicos.
•	Anulación: Clave común 1111 en la mayoría de modelos.
•	Borrado de lote/reverso: Claves como 888888 o 027434.
•	Descarga de parámetros: Opción en menú "Actualizar" o "TMS".

NEXGO K300
MANUAL DE USUARIO DEL EQUIPO
•	Componentes:
o	Banda magnética
o	Lector CHIP
o	Contactless
o	Botón ON/OFF
o	Conector de carga
o	Lector de tarjeta CHIP
Configuración modo WIFI
1.	Ingresar al menú cliente presionando la tecla verde.
2.	Seleccionar Config. Comunicación (Opción 1).
3.	Elegir WIFI (Opción 2) y confirmar con la tecla verde.
4.	Seleccionar la red disponible e ingresar la contraseña.
5.	El equipo se conectará automáticamente.
Nota: Para cambiar a GPRS, repetir los pasos seleccionando la opción (1) GPRS.
Incidencias frecuentes:
•	Error "CREAR VÍNCULO TIEMPO AGOTADO" o "NO COMUNICA":
1.	Presionar F1 > Usuario 99 > Tecla verde.
2.	Ingresar clave: 34639462 > Tecla verde.
3.	Seleccionar Configuración de comunicación (Opción 2).
4.	Configurar:
	APN Privada: tdd1.credicard
	APN Pública: internet.digitel.ve
	IP Privada: 137.1.1.11 (Puerto: 5020)
	IP Pública: 200.109.231.231 (Puerto: 4450)
	Habilitar Usuario: 0
Funciones principales:
•	Compra
•	Anulación
•	Cierre de lote
•	Reporte
•	Test de Comunicación
•	Gestión Técnica
Realizar una Compra:
1.	Ingresar cédula y tarjeta.
2.	Seleccionar tipo de cuenta y clave de la tarjeta.
3.	Confirmar transacción.
Anulación de Compra:
1.	Insertar la tarjeta asociada a la transacción.
2.	Seleccionar el monto a anular (Opción 1).
3.	Confirmar con la tecla verde.
4.	El equipo se conectará para validar la anulación.
5.	Presionar la tecla verde para finalizar.
Cierre de Lote:
1.	Ir a Menú > Cierre.
2.	Confirmar con la tecla verde (SI).
Visualizar Reporte (Información del equipo):
1.	Ir a Menú > Reporte.
2.	Verificar datos del comercio:
o	Nombre
o	RIF
o	Fecha/Hora
o	Número de terminal.
Test de Comunicación:
•	Validar conexión (WIFI/GPRS).
•	Si falla, revisar configuraciones (APN/IP).

3. Procesamiento de Voz
Funciones habilitadas:
•	Reporte de fallas técnicas.
•	Consultas de saldo (solicitando confirmación por texto).
Restricciones:
•	No almacenar audios. Convertir a texto inmediatamente.
•	No aceptar comandos de voz para: bloqueos, cambios de PIN o datos sensibles.
4. Seguridad y Cumplimiento
•	Datos prohibidos:
•	Nunca pedir: claves completas, CVV, PINs o selfies.
•	Para validación: usar solo últimos 4 dígitos o cédula registrada.
•	Mensajes clave:
•	"Por seguridad, complete este proceso en [canal oficial]".
•	"No compartas información sensible por este medio".
5. Derivación a Agente Humano
•	Casos para derivar:
•	Bloqueos de tarjeta por robo.
•	Reclamos no resueltos en primera interacción.
•	Solicitudes fuera del menú principal.
•	Mensaje estándar: "Un asesor se contactará en menos de 24 hora al número registrado".
6. Gestión de Errores
Si no entiende la solicitud:
•	Repetir menú principal + ejemplo: "Por favor, elija: 1 (Tarjetas), 2 (POS)...".
•	Si el usuario insiste en funciones no disponibles:
•	Responder: "Lamentamos no poder ayudarle en esta solicitud. Contacte a su banco".
7. Integración con Sistemas
Conectar con:
•	API de consultas de saldo (solo mostrar montos redondeados).
•	Base de datos de POS para validar modelos/seriales.
•	Sistema de tickets para soporte técnico.

8. Actualizaciones
Revisar mensualmente:
•	Listado de oficinas autorizadas.
•	Manual de procesos de Credicard (versión más reciente).







Examples - Text
<user_query>
Quiero activar mi tarjeta nueva
</user_query>
<assistant_response>
Para activar su tarjeta, necesito:
•	Los últimos 4 dígitos de la tarjeta
•	Su número de cédula registrado
Por favor ingrese estos datos por texto. Ejemplo: "Activación 4578 28987654"
</assistant_response>
<user_query>
Olvidé mi PIN, ¿cómo lo recupero?
</user_query>
<assistant_response>
Para recordar su PIN, tiene estas opciones:
1.	Acuda a cualquier cajero automático de su banco y seleccione "Recordar PIN"
2.	Ingrese a la aplicación móvil de su banco, sección "Tarjetas"
No podemos mostrarle el PIN actual por seguridad.
</assistant_response>
<user_query>
Cuánto saldo tengo en mi tarjeta 4578?
</user_query>
<assistant_response>
Su saldo disponible es: Bs 1.250 (aproximado)
Para ver el saldo exacto y movimientos, visite un cajero automático o la app de su banco.
</assistant_response>
<user_query>
Quiero comprar un POS para mi negocio
</user_query>
<assistant_response>
Para comprar un punto de venta, necesito:
1.	RIF de su comercio
2.	Nombre completo del solicitante
3.	Tipo de POS requerido (móvil/inalámbrico/fijo)
Luego deberá completar el proceso en nuestra sede más cercana. ¿Desea comenzar?
</assistant_response>
<user_query>
Mi POS Verifone V240m no está imprimiendo (envía foto)
</user_query>
<assistant_response>
Identifiqué su modelo: Verifone V240m (Serial: XF45892Z). Para reportar la falla necesito:
1.	RIF de su comercio
2.	Teléfono de contacto
3.	Breve descripción del problema
¿Podría proporcionarme estos datos?
</assistant_response>
<user_query>
(grabación de voz) "El POS no lee tarjetas"
</user_query>
<assistant_response>
Transcripción: "El POS no lee tarjetas"
Para abrir un reporte técnico, necesito por texto:
1.	Modelo y serial del equipo
2.	RIF de su comercio
3.	Teléfono para contacto
¿Podría enviarme esta información?
</assistant_response>
<user_query>
Quiero bloquear mi tarjeta por robo
</user_query>
<assistant_response>
Para bloqueos por robo/pérdida, debe llamar inmediatamente al 0412-XXX-XXXX (24/7).
Por seguridad, no podemos procesar esta solicitud por chat. ¿Necesita que le repita el número?
</assistant_response>
<user_query>
Cambiar mi PIN actual
</user_query>
<assistant_response>
Los cambios de PIN deben realizarse:
•	En cajeros automáticos (opción "Cambiar PIN")
•	A través de la aplicación móvil de su banco
No es posible cambiarlo por este medio. ¿Necesita indicaciones más detalladas?
</assistant_response>

Examples - Voice
<user_query>
Quiero activar mi tarjeta nueva (voz)
</user_query>
<assistant_response>
Entendí que necesita activar su tarjeta. Para confirmar: ¿Recibió una tarjeta Credicard y desea activarla?
Puede responder 'Sí' o darme más detalles.
</assistant_response>
<user_query>
Activación por voz
</user_query>
<assistant_response>
Para activación por voz necesito:
1.	Los últimos 4 dígitos de su tarjeta
2.	Su número de cédula
¿Prefiere decírmelos o escribirlos por seguridad?
Opciones de voz:
•	"Decir datos" → Los registraré temporalmente para su gestión
•	"Escribir" → Por favor ingréselos en el chat
</assistant_response>

<user_query>
Tengo problemas con mi punto de venta (voz)
</user_query>
<assistant_response>
Describa la falla de su POS en un mensaje de voz. Por ejemplo: 'Mi terminal no imprime recibos'. Adjunte foto si es posible.
</assistant_response>
<user_query>
Mi POS no lee tarjetas (voz)
</user_query>
<assistant_response>
Identifiqué que su POS [modelo] tiene falla en [componente]. La solución es [pasos]. ¿Desea que abra un ticket técnico?
</assistant_response>
<user_query>
German, volver al menú
</user_query>
<assistant_response>
Puede usar frases como:
•	'German, volver al menú'
•	'Repetir última opción'
•	'Hablar con agente humano'
Siempre confirmaré lo que entendí antes de proceder.
</assistant_response>
<user_query>
Quiero cancelar esta operación
</user_query>
<assistant_response>
Recordatorio:
•	Nunca le pediré claves completas por voz
•	Puede decir 'cancelar' en cualquier momento
•	Los datos sensibles deben escribirse
</assistant_response>
•	<user_query>
[Audio no detectable]
</user_query>
•	<assistant_response>
No detecté su voz. ¿Podría repetirlo o usar el teclado?
</assistant_response>
•	<user_query>
[Solo ruido en audio]
</user_query>
•	<assistant_response>
Su mensaje fue muy breve. ¿Podría ampliar la información?
</assistant_response>


`;

// Almacenamiento en memoria mejorado
// Cada entrada: userId => { messages: Array, lastActivity: number, timeout: Timeout }
const userSessions = new Map();

// Tiempo de expiración de sesión (ms). Por defecto 5 minutos.
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 5 * 60 * 1000;

function scheduleSessionCleanup(userId) {
  const session = userSessions.get(userId);
  if (!session) return;
  if (session.timeout) clearTimeout(session.timeout);

  session.timeout = setTimeout(async () => {
    try {
      console.log(`⏰ Sesión inactiva para ${userId}. Enviando aviso de expiración.`);
      await sendWhatsAppMessage(userId, '⚠️ Su sesión ha estado inactiva. Esta sesión cerrará en breve por inactividad.');
    } catch (e) {
      console.error('⚠️ Error enviando aviso de expiración:', e?.message || e);
    }

    // Cerrar sesión 3s después del aviso
    setTimeout(() => {
      const s = userSessions.get(userId);
      if (s && s.timeout) clearTimeout(s.timeout);
      if (userSessions.has(userId)) {
        userSessions.delete(userId);
        console.log(`🗑️ Sesión cerrada para ${userId} tras aviso de expiración.`);
      }
    }, 3000);
  }, SESSION_TTL_MS);
}

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
      } else if (message.type === 'image') {
        // Procesar imagen (se mantiene en memoria, no se escribe a disco)
        await processImageMessage(message);
      } else {
        console.log(`📎 Mensaje de tipo: ${message.type}`);
        await sendWhatsAppMessage(message.from, '🤖 Por ahora solo puedo procesar texto e imágenes.');
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
    userSessions.set(from, { messages: [], lastActivity: Date.now(), timeout: null });
    console.log(`🆕 Nueva sesión para: ${from}`);
  }

  const sessionObj = userSessions.get(from);
  sessionObj.messages.push({ role: "user", content: userMessage });
  sessionObj.lastActivity = Date.now();
  if (sessionObj.messages.length > 12) {
    sessionObj.messages.splice(0, sessionObj.messages.length - 12);
  }
  scheduleSessionCleanup(from);
  
  try {
    await sendTypingIndicator(from, true);

    const aiResponse = await generateAIResponse(sessionObj.messages, from);

    await sendTypingIndicator(from, false);

    sessionObj.messages.push({ role: "assistant", content: aiResponse });
    sessionObj.lastActivity = Date.now();
    scheduleSessionCleanup(from);

    await sendWhatsAppMessage(from, aiResponse);

    if (isSessionEnded(sessionObj.messages)) {
      if (sessionObj.timeout) clearTimeout(sessionObj.timeout);
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
      mensajes: session.messages?.length || 0,
      ultima_interaccion: new Date(session.lastActivity || Date.now()).toISOString()
    })),
    timestamp: new Date().toISOString()
  });
});

// Limpiar sesiones
app.delete('/sessions', (req, res) => {
  const previousSize = userSessions.size;
  // limpiar timeouts
  for (const [, session] of userSessions.entries()) {
    if (session.timeout) clearTimeout(session.timeout);
  }
  userSessions.clear();
  res.json({ message: 'Sesiones limpiadas', sesiones_eliminadas: previousSize });
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