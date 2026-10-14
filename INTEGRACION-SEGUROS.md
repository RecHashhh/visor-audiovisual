# Hub corporativo y seguros

La ruta `/` es el selector autenticado. Audiovisual conserva su contenido en `/audiovisual` y mantiene las rutas de proyectos, biblioteca y administración existentes. El botón Módulos vuelve al selector.

La configuración pública de las fichas está en `frontend/src/config/hubModules.js`. Se puede sobrescribir mediante `window.__APP_CONFIG__.hubModules`: `insuranceUrl`, `insuranceEnabled`, `insuranceReviewEmails`, `insuranceReviewOids`. Esta configuración controla la presentación y no concede permisos en Seguros. Solo se admiten destinos HTTPS sin credenciales ni parámetros.

Inicialmente la ficha de Seguros se muestra a Daniel, Germania y Jacqueline por los correos confirmados, y a William por su identificador Microsoft verificado. Se exige además que el servidor del Hub confirme el acceso. Si falla la verificación de permisos se ofrece Reintentar y no se habilitan acciones administrativas.

Seguros recibe el acceso en `/api/auth/microsoft/start?entry=hub`, con OIDC y PKCE propios. Entra aprovecha su sesión existente en el navegador: no se copian tokens ni cookies entre dominios. El servidor de Seguros valida firma, audiencia, tenant, nonce, estado de un solo uso, navegador y la lista de revisión. No es necesario registrar una contraseña adicional. Microsoft puede pedir consentimiento o autenticación si la sesión o sus políticas lo requieren.

Antes de publicar el Hub, desplegar Seguros y activar la configuración de `docs/ACCESO-REVISION.md` de ese repositorio. Cada módulo conserva su sesión local; cerrar sesión en una aplicación no cierra Microsoft 365 ni las otras aplicaciones. No se ha implementado cierre global del Hub.

Validación: build de Vite, prueba de visibilidad del selector, navegador en 1440/768/390 px, navegación Audiovisual → Módulos, usuario sin ficha de Seguros y recuperación de errores de permisos. El recorrido Microsoft real con las cuatro cuentas se debe comprobar después de publicar; las pruebas locales no simulan consentimiento ni políticas del tenant.
