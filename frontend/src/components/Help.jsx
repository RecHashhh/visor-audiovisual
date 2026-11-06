// Ayuda «?» uniforme: círculo pequeño que no hereda el tamaño del título y
// muestra la explicación al pasar el mouse o al enfocarlo con el teclado.
export default function Help({ text }) {
  return <span className="help-dot" tabIndex={0} role="img" aria-label={text} title={text}>?</span>
}
