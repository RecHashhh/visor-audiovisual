# Hub corporativo y seguros

La ruta `/` es el selector autenticado. Audiovisual conserva su contenido en `/audiovisual` y mantiene las rutas de proyectos, biblioteca y administración existentes. El botón Módulos vuelve al selector.

La configuración pública de las fichas está en `frontend/src/config/hubModules.js`. Se puede sobrescribir mediante `window.__APP_CONFIG__.hubModules`: `insuranceUrl` e `insuranceEnabled`. Esta configuración controla la presentación y no concede permisos en Seguros. Solo se admiten destinos HTTPS sin credenciales ni parámetros.

La ficha de Seguros se muestra a cualquier cuenta cuyo acceso al Hub esté confirmado. Al entrar, Seguros vincula la cuenta con sus registros por correo, nombre o documento cuando existe una coincidencia; una coincidencia no concede permisos administrativos ni de consulta global.

Seguros recibe el acceso en `/api/auth/microsoft/start?entry=hub`, con OIDC y PKCE propios. El Hub agrega el `login_hint` de la cuenta Microsoft ya autenticada para que Entra reutilice y seleccione esa sesión cuando esté disponible; no se copian tokens ni cookies entre dominios. El servidor de Seguros valida firma, audiencia, tenant, nonce, estado de un solo uso y navegador. No es necesario registrar una contraseña adicional. Microsoft puede pedir consentimiento, MFA o autenticación si la sesión expiró o sus políticas lo requieren.

Cada módulo conserva su sesión local; cerrar sesión en una aplicación no cierra Microsoft 365 ni las otras aplicaciones. No se ha implementado cierre global del Hub.

Validación: build de Vite, prueba de visibilidad del selector, navegador en 1440/768/390 px, navegación Audiovisual → Módulos, usuario sin ficha de Seguros y recuperación de errores de permisos. El recorrido Microsoft real con las cuatro cuentas se debe comprobar después de publicar; las pruebas locales no simulan consentimiento ni políticas del tenant.

## Tesorería · 28-oct-2026

La ficha «Tesorería» se habilita para todas las cuentas cuyo acceso al Hub esté confirmado, incluidas las que no tienen secciones de Audiovisual. No tiene lista de revisión ni restricción por grupo en esta etapa. La restricción por grupo queda pendiente de una decisión posterior del responsable.

El destino confirmado en el despliegue de `RIPCONCIV/RPC-TESORERIAWEB` es `https://appweb-tesoreriaweb-ahend3bzcpecaffv.eastus-01.azurewebsites.net/`. La raíz y `/api/salud` respondieron 200 durante la comprobación. Se configura con `treasuryUrl` y `treasuryEnabled` en `window.__APP_CONFIG__.hubModules`; se exige un origen HTTPS sin credenciales, ruta adicional, parámetros ni fragmento.

Tesorería usa su propio inicio de sesión Microsoft y valida sus tokens en el servidor. No se intercambian tokens ni cookies entre aplicaciones. La ficha permite abrir el sistema; Tesorería conserva los roles existentes y las cuentas desactivadas siguen bloqueadas. Las cuentas corporativas nuevas pueden iniciar sesión y requieren que Administración les asigne un perfil para ver información. No se amplían permisos financieros al agregar la ficha al Hub.
