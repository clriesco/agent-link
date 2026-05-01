# SRS-002: Canal de comunicación inter-agente de confianza

**Autor:** Roy  
**Fecha:** 2026-05-01  
**Estado:** Pendiente de decisión de implementación

---

## 0. Actores

| Actor | Tipo |
|-------|------|
| **Charly** | Humano |
| **Roy** | Agente |
| **Eva** | Agente |

---

## 1. Problemática

Los agentes del sistema (Roy, Eva, Paco) necesitan comunicarse entre sí de forma
autónoma, sin intermediación humana, para coordinar tareas operativas. La arquitectura
actual no ofrece ningún canal que cumpla simultáneamente tres requisitos:

1. **Bidireccional y persistente** — Roy puede escribir a Eva y Eva puede responder a Roy
   sin que el mensaje pase por la sesión de un humano.
2. **Confiable (trusted)** — El agente receptor puede verificar que el mensaje proviene
   de otro agente del sistema, no de contenido arbitrario inyectado.
3. **Autónomo** — No depende de que un humano inicie o intermedie la conversación.

Adicionalmente, todos los proveedores de mensajería (Telegram, Discord, Slack) bloquean
la comunicación DM bot↔bot. La única opción en esos proveedores son canales/grupos
compartidos, lo que introduce un humano como mediador implícito del canal.

---

## 2. Objetivo

Habilitar un canal de comunicación directo entre agentes del sistema que:

- No pase por la sesión de ningún humano
- Sea marcado como **trusted** por el gateway — el agente receptor confía en que el
  emisor es quien dice ser, sin depender del cuerpo del mensaje
- Permita **respuesta asíncrona**: el agente receptor puede responder al emisor sin
  que haya un humano en el loop
- Sea **transparente** para el gateway — no requiere cambios en OpenClaw, solo un
  plugin o extensión de GlueClaw

---

## 3. Alternativas actuales descartadas

### 3.1 `sessions_send` inyectado en la sesión compartida con Charly

`sessions_send` con `sessionKey: agent:evacastro:telegram:direct:540382330` enruta
el mensaje a través de la sesión que Eva comparte con Charly. Problemas:

- **El mensaje aparece en el contexto de Charly** — Eva responde en su canal de Telegram
  con Charly, no en un canal Roy↔Eva independiente.
- **El requester session key es incorrecto** — se envía el `agentDir` del proceso
  (`/home/pacolobo/.openclaw/agents/roy`) en lugar de `agent:roy:telegram:direct:540382330`
  (bug pendiente de #32 sin resolver).
- **Sin canal de retorno para Roy** — Eva puede responder a Charly, no a Roy.

### 3.2 `POST /hooks/agent`

Llamada HTTP que dispara una sesión nueva de Eva (hook session). Problemas:

- **Fire-and-forget** — Eva procesa el mensaje en una sesión desechable sin canal de
  retorno. Roy no recibe respuesta.
- **Marcado como untrusted** — el contenido del hook llega como user-role sin
  autenticación del emisor.
- **Sin identidad verificable** — Eva no puede distinguir si el mensaje viene de Roy o
  de cualquier otro proceso que conozca el endpoint y el token.

### 3.3 `sessions_spawn` — subagente

Roy lanza a Eva como subagente suyo. Problemas:

- **Eva queda subordinada** — el modelo de subagente implica jerarquía (Eva trabaja
  para Roy en esa sesión), lo que no refleja la relación operativa real.
- **Sesión efímera** — el subagente vive mientras Roy lo mantiene activo. No es un
  canal persistente.
- **La respuesta vuelve a Roy, no a Eva** — el canal es unidireccional desde el punto
  de vista del agente receptor.
- **Sin contexto de Eva** — el subagente arranca sin el historial ni la identidad de
  la sesión de Eva.

---

## 4. Propuesta: Plugin de canal inter-agente para OpenClaw

### Concepto

Un **plugin nativo de OpenClaw** que registra un nuevo canal de comunicación
(`agent-to-agent` o similar), siguiendo exactamente el mismo patrón que el plugin
de Telegram u otros providers ya existentes.

El plugin implementa el ciclo de vida de un provider de OpenClaw:
- Se registra como canal en el gateway al arranque
- Gestiona el enrutado de mensajes entre agentes de forma interna (sin Telegram,
  Discord, ni ningún proveedor externo)
- Los mensajes que procesa entran en las sesiones de los agentes receptores por el
  mismo camino que los mensajes de Charly por Telegram — es decir, como **input de
  canal configurado por el operador**, trusted por diseño

GlueClaw no interviene. Es un asunto exclusivo de OpenClaw.

### Por qué el modelo de plugin de canal resuelve el problema de trust

Los providers de OpenClaw son componentes del operador. Un mensaje que llega a través
de un provider configurado no necesita ser marcado como `[Inter-session message]` ni
wrapeado como untrusted — el gateway lo trata como input legítimo del canal, igual que
un mensaje de Telegram de un sender autorizado.

La identidad del emisor (Roy, Eva, Paco) quedaría garantizada por la configuración del
plugin y el routing interno del gateway, no por el contenido del mensaje.

### Analogía con el canal de Telegram

| Concepto | Telegram | Plugin inter-agente |
|---|---|---|
| Transporte | API Telegram (HTTP polling/webhook) | Comunicación interna del gateway |
| Autenticación del sender | Telegram user ID verificado | Agente ID verificado por el gateway |
| Nivel de trust | Trusted (provider configurado) | Trusted (provider configurado) |
| Configuración | `providers.telegram.*` en openclaw.json | `providers.agent.*` en openclaw.json |
| Sesiones | `agent:<id>:telegram:<kind>:<chatId>` | `agent:<id>:agent:<kind>:<targetId>` |

---

## 5. Plan de trabajo

### Fase 1 — Análisis (sin código)

1. **Estudiar la arquitectura de un plugin de provider en OpenClaw**: cómo registra
   un canal, qué interfaces implementa, qué ciclo de vida tiene. Referencia: plugin
   de Telegram (`extensions/telegram/`) en el source de OpenClaw.

2. **Identificar el API de inyección de mensajes** en el gateway: cómo un cliente
   WS autenticado como owner dispara un turn en una sesión agente específica sin
   pasar por un provider de Telegram/Discord.

3. **Definir la interfaz del canal**: qué eventos emite (mensaje entrante, estado de
   entrega), qué métodos expone (send, reply), cómo se identifican las sesiones
   (`agent:<id>:agent:direct:<targetAgentId>`).

4. **Verificar que OpenClaw permite registrar providers custom** sin modificar el
   core — revisar el sistema de plugins del gateway y los puntos de extensión.

### Fase 2 — Especificación técnica

5. **Diseño de la sesión de canal**: estructura de la sesión en el gateway, clave de
   sesión, cómo el agente receptor ve el mensaje en su contexto, cómo responde.

6. **Diseño del enrutado**: cómo el gateway sabe que un mensaje Roy→Eva debe activar
   la sesión de Eva con el canal `agent` como provider, qué delivery context se
   construye, cómo llega la respuesta de Eva a Roy.

7. **Diseño de la configuración**: qué entradas añadir a `openclaw.json` para activar
   el canal entre un par de agentes.

### Fase 3 — Implementación (Charly)

8. **Implementar el plugin** siguiendo la arquitectura de provider de OpenClaw.
   Sin tocar GlueClaw.

9. **Integración en STANDING_ORDERS**: documentar el nuevo mecanismo de confianza y
   las reglas de comportamiento para los agentes al usar el canal.

### Fase 4 — Validación

10. **Test bidireccional completo**: Roy→Eva trusted, Eva→Roy trusted, sin pasar por
    sesión de Charly.

11. **Auditoría de seguridad**: confirmar que el canal no puede ser suplantado por
    contenido malicioso en el cuerpo de un mensaje.

---

## 6. Riesgos y consideraciones

| Riesgo | Mitigación |
|--------|------------|
| Un agente comprometido podría enviar mensajes trusted en nombre de otro | La autenticación es a nivel de proceso (device key), no de agente. Todos los agentes del mismo proceso compartirían el mismo nivel de trust. Documentar y aceptar. |
| El gateway podría no permitir inyección directa de sesión sin provider | A verificar en Fase 1. Si no es posible, retroceder a alternativa de sesión de grupo dedicada. |
| Acoplamiento a internals del gateway WS | Mismo riesgo que con el MCP loopback. Mitigar documentando el protocolo y añadiendo tests. |

---

## 7. Cómo implementar

Esta sección describe la estructura del plugin y los métodos del SDK de OpenClaw
necesarios para implementar el canal inter-agente conforme al estándar de
extensiones nativas de OpenClaw.

> La guía de referencia online es `https://docs.openclaw.kr/plugins/sdk-channel-plugins`.
> No existe equivalente en los docs locales de esta instalación.

---

### 8.1 Estructura de ficheros

Un plugin de canal nativo de OpenClaw requiere como mínimo:

```
agent-link/
├── package.json          # openclaw.channel + openclaw.extensions + openclaw.setupEntry
├── openclaw.plugin.json  # id, kind: "channel", configSchema
├── index.ts              # entry point completo (modo "full")
├── setup-entry.ts        # entry ligero (modo "setup-only")
└── src/
    ├── channel.ts        # objeto ChannelPlugin
    ├── monitor.ts        # bus de mensajes interno
    └── inbound.ts        # despacho al motor de turns del gateway
```

**`package.json`** — campos obligatorios para que OpenClaw reconozca el canal:

```json
{
  "name": "@locamala/agent-link",
  "type": "module",
  "openclaw": {
    "extensions": ["./index.ts"],
    "setupEntry": "./setup-entry.ts",
    "channel": {
      "id": "agent-link",
      "label": "Agent Link",
      "blurb": "Canal de comunicación inter-agente de confianza."
    }
  }
}
```

**`openclaw.plugin.json`** — manifiesto del plugin:

```json
{
  "id": "agent-link",
  "kind": "channel",
  "channels": ["agent-link"],
  "name": "Agent Link",
  "description": "Canal de comunicación directa entre agentes del sistema.",
  "configSchema": { ... }
}
```

---

### 8.2 Entry points

OpenClaw distingue dos modos de carga del plugin:

- **`full`** — arranque normal del gateway. Aquí se registra todo: canal, gateway
  adapter, métodos, servicios.
- **`setup-only`** — carga ligera cuando el canal está desconfigurado o desactivado.
  Solo registra metadatos del canal.

**`index.ts`** — entry completo:

```typescript
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { agentLinkPlugin } from "./src/channel.js";

export default defineChannelPluginEntry({
  id: "agent-link",
  name: "Agent Link",
  description: "Canal de comunicación directa entre agentes del sistema.",
  plugin: agentLinkPlugin,
});
```

**`setup-entry.ts`** — entry ligero:

```typescript
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { agentLinkPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(agentLinkPlugin);
```

Ambas funciones se importan de `openclaw/plugin-sdk/core`. El alias `openclaw/plugin-sdk/*`
es resuelto por el loader de plugins de OpenClaw (vía `jiti`) hacia la instalación activa
del core — garantiza que no hay desajustes de versión.

---

### 8.3 El objeto `ChannelPlugin`

El canal se construye con `createChatChannelPlugin` de `openclaw/plugin-sdk/channel-core`.
Este builder acepta adapters opcionales y compone el objeto `ChannelPlugin` que el gateway
consume al registrar el canal.

```typescript
import { createChatChannelPlugin, createChannelPluginBase } from "openclaw/plugin-sdk/channel-core";

export const agentLinkPlugin = createChatChannelPlugin({
  base: createChannelPluginBase({
    id: "agent-link",
    setup: { resolveAccount, inspectAccount },
  }),

  security: { ... },   // control de acceso: qué agentes están autorizados
  outbound: { ... },   // cómo se entrega la respuesta al agente emisor
  gateway: { ... },    // ciclo de vida del monitor (arranque y parada)
});
```

Los adapters relevantes para este canal:

| Adapter | Función |
|---------|---------|
| `base.setup.resolveAccount` | Resuelve la configuración del par de agentes autorizados |
| `base.setup.inspectAccount` | Informa al gateway si el canal está configurado y activo |
| `security.dm` | Define la política de acceso: solo agentIds del par configurado |
| `outbound.attachedResults.sendText` | Entrega la respuesta del agente receptor al emisor |
| `gateway.monitor` | Arranca el bus de mensajes interno; se para al abortar |

---

### 8.4 Inbound: despacho al motor de turns

Cuando llega un mensaje de un agente emisor, el plugin debe convertirlo en un turn
de canal trusted en la sesión del agente receptor. El punto de integración con el
core es:

```typescript
import { runInboundReplyTurn } from "openclaw/plugin-sdk/inbound-reply-dispatch";
```

`runInboundReplyTurn` delega en `runChannelTurn` del core. Los parámetros que
necesita el canal inter-agente:

| Parámetro | Descripción |
|-----------|-------------|
| `channel` | `"agent-link"` — identificador del canal registrado |
| `accountId` | ID de la cuenta del agente destino |
| `routeSessionKey` | Clave de sesión del agente destino: `agent:<id>:agent-link:direct:<fromAgentId>` |
| `storePath` | Ruta al store de sesiones del agente destino |
| `ctxPayload` | `FinalizedMsgContext` — construido con `buildChannelTurnContext` |
| `recordInboundSession` | Función del core, inyectada por el gateway en el adapter `gateway` |
| `dispatchReplyWithBufferedBlockDispatcher` | Función del core, inyectada igual |
| `delivery.deliver` | Callback de outbound: entrega la respuesta al emisor |

Las dos funciones del core (`recordInboundSession` y `dispatchReplyWithBufferedBlockDispatcher`)
**no hay que buscarlas ni importarlas**: el gateway las inyecta automáticamente en el
`gateway` adapter del `ChannelPlugin` al arrancar. El plugin las almacena y las pasa
a `runInboundReplyTurn` cuando procesa cada mensaje.

La función auxiliar `buildChannelTurnContext` de `openclaw/plugin-sdk/channel-core`
permite construir el `FinalizedMsgContext` a partir de los facts del mensaje
(sender, texto, conversación, ruta).

Para el patrón completo de ensamblado, también está disponible:

```typescript
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
```

que combina `buildInboundReplyDispatchBase` + `recordInboundSessionAndDispatchReply`
en una sola llamada, reduciendo el boilerplate.

---

### 8.5 Outbound: entrega de la respuesta

El callback `delivery.deliver` del turn de inbound es donde el canal recibe la
respuesta del agente receptor y la enruta de vuelta al emisor.

Para formatear y entregar texto plano desde un `ReplyPayload`:

```typescript
import { deliverFormattedTextWithAttachments } from "openclaw/plugin-sdk/reply-payload";
```

La entrega al emisor se implementa llamando de nuevo a `runInboundReplyTurn` en
la sesión del agente **emisor** — convirtiendo la respuesta en un turn trusted en
esa sesión. Esto cierra el ciclo bidireccional sin salir del proceso.

---

### 8.6 El gateway adapter y el bus de mensajes

El adapter `gateway` del `ChannelPlugin` recibe del core las dependencias necesarias
y arranca el mecanismo de transporte del canal. En el caso inter-agente, el
"transporte" es un bus de mensajes en memoria — sin red, sin polling externo.

El ciclo de vida del monitor se gestiona con:

```typescript
import { runStoppablePassiveMonitor } from "openclaw/plugin-sdk/extension-shared";
```

`runStoppablePassiveMonitor` envuelve el loop con gestión de `abortSignal` y
backoff, siguiendo el mismo patrón que todos los monitores de canal de OpenClaw.

El bus de mensajes puede implementarse como un `EventEmitter` o un `Map<agentId, queue>`
en memoria del proceso. Cuando Roy llama `api.registerGatewayMethod("agentlink.send")`
y el gateway ejecuta el handler, el bus emite el evento al listener del agente destino,
que lo procesa vía `runInboundReplyTurn`.

---

### 8.7 Punto de entrada para el agente emisor

El plugin debe registrar un gateway method que los agentes puedan llamar para enviar
mensajes. Esto se hace en el `registerFull` del entry point:

```typescript
registerFull(api) {
  api.registerGatewayMethod("agentlink.send", async (params, ctx) => {
    // params: { from: agentId, to: agentId, text: string }
    // → emitir en el bus → runInboundReplyTurn en la sesión del receptor
  });
}
```

`registerGatewayMethod` pertenece a `OpenClawPluginApi` y registra un handler RPC
en el WebSocket del gateway, accesible por cualquier cliente con scope de operador —
incluyendo los agentes del mismo gateway a través del MCP loopback.

---

### 8.8 Configuración en `openclaw.json`

```json
{
  "plugins": {
    "load": { "paths": ["~/.openclaw/extensions/agent-link"] },
    "entries": {
      "agent-link": { "enabled": true }
    }
  },
  "channels": {
    "agent-link": {
      "pairs": [
        { "from": "roy", "to": "evacastro" },
        { "from": "evacastro", "to": "roy" }
      ]
    }
  }
}
```

El plugin se activa con restart del gateway. Los cambios en `openclaw.json` que
añadan o modifiquen entradas de plugin siempre requieren restart — no hay hot-reload
para código de plugin en ejecución.

---

## 8. Documentación de referencia

Ruta base: `/home/pacolobo/.openclaw/workspace-roy/docs/openclaw/`

> **Nota:** Los docs del Plugin SDK (`plugins/`) no están disponibles localmente en esta
> copia de la documentación. Consultar directamente el source de OpenClaw en GitHub o la
> instalación de npm (`/home/linuxbrew/.linuxbrew/Cellar/node/25.9.0_2/lib/node_modules/openclaw/docs/`)
> para la sección de plugins.

### Sesiones y multi-agente

| Fichero | Por qué es relevante |
|---------|----------------------|
| `concepts/session.md` | Modelo de sesión: qué es, cómo se identifica, ciclo de vida |
| `concepts/multi-agent.md` | Arquitectura multi-agente en OpenClaw |
| `concepts/channel-docking.md` | Cómo un canal se "acopla" a una sesión |
| `concepts/session-tool.md` | Herramientas de sesión (`sessions_send`, `sessions_spawn`, etc.) |
| `concepts/agent-runtimes.md` | Runtimes de agente y modelo de extensión |
| `concepts/delegate-architecture.md` | Arquitectura de delegación entre agentes |

### Gateway — autenticación y confianza

| Fichero | Por qué es relevante |
|---------|----------------------|
| `gateway/authentication.md` | Modelo de autenticación del gateway (device pairing, tokens) |
| `gateway/trusted-proxy-auth.md` | Cómo configurar un proxy con trust elevado — patrón aplicable al canal inter-agente |
| `gateway/protocol.md` | Protocolo WebSocket del gateway |
| `gateway/config-channels.md` | Configuración de canales en `openclaw.json` |
| `gateway/config-agents.md` | Configuración de agentes en `openclaw.json` |
| `gateway/bridge-protocol.md` | Protocolo de bridge interno del gateway |

### Canal de referencia (patrón a seguir)

| Fichero | Por qué es relevante |
|---------|----------------------|
| `channels/telegram.md` | Canal de Telegram: referencia del patrón provider que se quiere replicar |
| `channels/channel-routing.md` | Cómo el gateway enruta mensajes entre canales y sesiones |
| `channels/pairing.md` | Modelo de pairing de canales |
