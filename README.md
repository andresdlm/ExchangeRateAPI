# API de tasas BCV

API en TypeScript para Cloudflare Workers, sin base de datos. Extrae USD, EUR y fecha de vigencia exclusivamente de https://www.bcv.org.ve/.

## Ejecutar

Requisitos: Node.js 22 o posterior y npm.

```sh
npm ci
cp .env.example .env
openssl rand -hex 32
```

Coloca la llave generada en `API_KEY` dentro de `.env`. No compartas ni versionas ese archivo. Wrangler admite `.env` para desarrollo; no crees simultáneamente `.dev.vars`, ya que tiene prioridad.

```sh
npm run dev
curl http://localhost:8787/api/v1/rates -H 'X-API-Key: TU_LLAVE'
npm run check
```

## Desplegar en Cloudflare

```sh
npx wrangler login
npx wrangler secret put API_KEY
npm run deploy
```

Introduce una llave aleatoria de al menos 32 caracteres cuando Wrangler la solicite. El secreto queda en Cloudflare y no necesita una BDD ni un archivo `.env` en producción. Puedes rotarlo repitiendo `secret put`. La API acepta una llave estática; no incorpora usuarios ni permisos por cliente.

Consulta `https://bcv-exchange-rate-api.<tu-subdominio>.workers.dev/api/v1/rates` usando `X-API-Key`. La autenticación se verifica en cada solicitud antes de leer la caché. Las respuestas al cliente usan `Cache-Control: no-store`.

## Contrato

`GET /api/v1/rates` devuelve:

```json
{
  "source": "https://www.bcv.org.ve/",
  "baseCurrency": "VES",
  "rates": { "USD": 871.3689, "EUR": 981.17880877 },
  "effectiveDate": "2026-10-05",
  "checkedAt": "2026-10-04T12:00:00.000Z",
  "updatedAt": "2026-10-04T12:00:00.000Z",
  "stale": false
}
```

Ejemplo basado en una captura del HTML oficial; no representa una consulta en tiempo real. Cada tasa indica bolívares por una unidad de la moneda. Las tasas de la respuesta son números JSON. La extracción y la caché conservan las cadenas decimales originales; solo se convierten al construir la respuesta. Antes de responder, se comprueba que la representación decimal del número conserva el valor publicado (ignorando ceros finales). Si la conversión redondearía el valor, devuelve `503 rates_unavailable` en lugar de alterar silenciosamente la tasa. No se redondea a dos decimales. Los números JavaScript usan coma flotante binaria: esta comprobación protege el valor decimal enviado en JSON, pero los cálculos posteriores pueden requerir una biblioteca decimal. Los ceros finales no se conservan como formato en un número (`871.36890000` se envía como `871.3689`).

`effectiveDate` es la fecha de vigencia publicada por el BCV y puede ser futura. La API devuelve la última publicación disponible, no un histórico ni una selección de la tasa vigente hoy. `checkedAt` indica la última consulta exitosa; `updatedAt`, cuándo se detectó un cambio de tasa o fecha. Las horas se expresan en UTC.

Errores JSON: `401 unauthorized`, `404 not_found`, `405 method_not_allowed` (con `Allow: GET`), `503 rates_unavailable` o `503 configuration_error`.

## Caché y actualización

La Cache API de Cloudflare guarda una copia interna durante hasta siete días. La actualización sigue una ventana diaria de lunes a viernes a las **18:00 de Venezuela (UTC-4)**. La primera solicitud posterior a esa ventana consulta el BCV (timeout de 10 segundos); las siguientes reutilizan la copia hasta la próxima ventana laborable. Sin tráfico no se consulta el BCV. Si falta la caché, se consulta inmediatamente, incluso antes de las 18:00 o en fin de semana.

La fecha publicada no se utiliza como prueba de que ya se completó la publicación de ese día: el BCV puede anunciar una tasa con vigencia futura. La programación se basa en la hora de la última consulta exitosa. Si los valores no cambian, se conserva `updatedAt` y se considera comprobada esa ventana.

Si falla el BCV, devuelve la copia disponible con `stale: true` y espera 60 segundos antes de reintentar. No sirve copias que llevan siete días sin una verificación exitosa. Si falta la copia, devuelve 503. No reemplaza tasas válidas por HTML incompleto o respuestas de error.

Configura `PUBLICATION_HOUR_VET` (entero de 0 a 23) y `CACHE_RETENTION_SECONDS` en `wrangler.jsonc`. La retención debe ser de al menos cuatro días para cubrir el fin de semana; por defecto es de siete días. La hora de las 18:00 es una decisión configurable, no un horario oficial confirmado. Si el BCV publica después de la consulta diaria o hace una corrección posterior, se detectará en la siguiente ventana. No se incluye un calendario de feriados: en un feriado entre lunes y viernes puede hacerse una consulta y obtener la misma tasa.

La caché es local a cada centro de datos, puede expulsar entradas y no ofrece almacenamiento persistente global. Es una consulta por ventana **por ubicación con caché disponible**, no una garantía de una única consulta global. Cada ubicación puede consultar el BCV por separado; una pérdida de caché, un arranque inicial o un fallo puede provocar consultas adicionales. Se agrupan solicitudes concurrentes dentro de un mismo isolate; no hay bloqueo global entre isolates. Un cron no actualizaría todas esas cachés locales, por lo que se usa actualización por solicitud. No se usan KV, D1 ni Durable Objects.

## Organización

- `src/domain`: datos, contratos y error de fuente.
- `src/application`: consulta, revalidación y manejo de fallos.
- `src/infrastructure`: extracción estructural HTML y Cache API.
- `src/http`: autenticación.
- `src/index.ts`: entrada HTTP y composición de dependencias.

Para seguir una consulta en el código, comienza en `handleRequest` (`src/index.ts`). Primero valida la llave y la ruta; después lee la configuración, obtiene el servicio y construye la respuesta. `GetRates.execute` agrupa las solicitudes concurrentes y `loadRates` decide si debe reutilizar la caché o consultar el BCV. Los métodos `createSnapshot` y `useCachedRatesAfterFailure` muestran por separado el camino exitoso y el manejo de una fuente no disponible.

Los valores de tiempo tienen nombres con sus unidades (`retentionSeconds`, `currentTime`, `RETRY_DELAY_MILLISECONDS`). Las funciones del parser identifican la moneda, normalizan la tasa y validan la fecha por separado. Los comentarios explican las decisiones menos evidentes: comparación de llaves, fecha de publicación, reintentos y protección de la precisión decimal.

Las interfaces separan la lógica de Cloudflare y BCV sin añadir un framework o un contenedor de inyección. `htmlparser2` permite extraer por estructura HTML sin expresiones regulares sobre el documento completo. Si el BCV cambia el HTML, ajusta el adaptador y su fixture.

Las pruebas cubren el HTML oficial capturado, validaciones, caché, revalidación, concurrencia, fallos y autenticación. `npx wrangler deploy --dry-run` verifica el empaquetado sin publicar. La conectividad BCV desde producción debe verificarse después del despliegue: que funcione desde un equipo local no garantiza que el BCV permita todas las ubicaciones de Cloudflare.

## Diagnóstico local

Si aparece `503`, revisa el cuerpo JSON: `configuration_error` indica configuración inválida y `rates_unavailable` indica que no se pudo consultar/validar la fuente y no había copia disponible. Los errores del adaptador se registran en la terminal sin imprimir la API key.

El BCV puede presentar una cadena HTTPS incompleta. `npm run dev` incorpora la cadena pública verificada de Sectigo (intermedio y raíz) para Node/Miniflare, manteniendo la validación TLS. Después de actualizar este proyecto, reinicia con ese comando; ejecutar directamente `npx wrangler dev` no aplica esta configuración. Consulta `certs/README.md` para el origen y mantenimiento del certificado.

En Network distingue la solicitud HTTP `/api/v1/rates` de las conexiones WebSocket del inspector, que pueden permanecer abiertas. Una respuesta HTTP 503 terminada no demuestra que esas conexiones estén bloqueadas. Bruno ofrece un timeout de 15 segundos para las consultas.
