import { useLayoutEffect, useState } from 'react';

// Alto que hace que la página termine justo en el borde inferior de la ventana: sin scroll
// que aparente más contenido y sin espacio vacío. Ajusta el alto actual del elemento en lo
// que sobra o falta en la página; en pantallas muy bajas respeta el mínimo y la página se desplaza.
export function useFit(ref, enabled, min, deps = []) {
  const [height, setHeight] = useState(null);
  useLayoutEffect(() => {
    if (!enabled) { setHeight(null); return undefined; }
    let frame = 0;
    const fit = () => {
      const el = ref.current;
      if (!el) return;
      const zoom = el.currentCSSZoom || 1; // monitores grandes: rectángulo en px de pantalla
      // Final real del contenido (no el de la ventana, que nunca es menor que su alto).
      const page = el.closest('.hw-page'), main = el.closest('.main');
      if (!page) return;
      const pad = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
      const overflow = page.getBoundingClientRect().bottom + window.scrollY + pad - window.innerHeight;
      const next = Math.max(min, Math.floor((el.getBoundingClientRect().height - overflow) / zoom));
      setHeight(previous => previous === null || Math.abs(previous - next) > 1 ? next : previous);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); };
    schedule();
    window.addEventListener('resize', schedule);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', schedule); };
  }, [enabled, min, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return height;
}
