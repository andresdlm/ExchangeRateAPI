# Certificado público para desarrollo local

El servidor `www.bcv.org.ve` presenta su certificado HTTPS sin el certificado intermedio necesario. Algunos clientes (por ejemplo curl en macOS) completan la cadena, mientras que Node y workerd local pueden fallar al validarla.

`sectigo-bcv-chain.pem` contiene el certificado público **Sectigo Public Server Authentication CA DV R36**, emitido por **Sectigo Public Server Authentication Root R46**, y esa raíz pública tomada del almacén de certificados de Node. El intermedio se obtuvo del URI CA Issuers anunciado por el certificado del BCV:

http://crt.sectigo.com/SectigoPublicServerAuthenticationCADVR36.crt

Se verificaron la firma del intermedio contra las raíces de Node y la cadena del certificado del BCV con `openssl verify`. No contiene llaves privadas. El script de desarrollo incorpora esta cadena mediante `NODE_EXTRA_CA_CERTS`, que también es leído por Miniflare. Si ya hay un archivo de certificados adicionales configurado, se conserva y se combina con este.

No se desactiva la validación TLS ni se utiliza HTTP para descargar las tasas. Este archivo solo configura el entorno local; no se empaqueta en el Worker. Si el BCV cambia de emisor y vuelve a presentar una cadena incompleta, habrá que revisar este certificado. La conexión desde Cloudflare en producción debe verificarse al desplegar.
