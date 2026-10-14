# Ilustraciones del selector

Generadas con la herramienta integrada de generación de imágenes. Archivos originales copiados al proyecto, sin sobrescribir otros recursos:

- `frontend/public/module-art/audiovisual.png`
- `frontend/public/module-art/seguros.png`

Prompts utilizados (especificación): ilustraciones editoriales corporativas de RIPCONCIV, paisaje 3:2 recortable a 2:1, fondo azul hielo y paleta azul marino `#192d96`, composición central con margen, sin texto, logos, marcas de agua ni interfaz. Audiovisual: cámara de video sobre trípode, galería de imágenes, símbolo de reproducción y obra con grúa. Seguros: escudo con verificación, documento de póliza, trabajador con casco y asesora con tableta, obra al fondo. Estilo coherente entre ambos recursos.

Las imágenes son decorativas (`alt` vacío); los títulos y enlaces identifican el destino de manera accesible. El recorte se aplica mediante CSS, con altura idéntica entre las dos fichas y movimiento reducido según la preferencia del navegador.

Cerrar sesión desde el selector, Audiovisual o Seguros conduce a `/salir` del Hub. Esa ruta limpia la caché local de MSAL y vuelve a `/login`. Seguros invalida primero su propia sesión. La sesión corporativa de Microsoft 365 permanece independiente.
