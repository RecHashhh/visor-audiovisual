let active
export function finishServiceLoading() {
  if (!active) return
  clearTimeout(active.timer)
  for (const [element, inert] of active.background) element.inert = inert
  active.element.remove()
  const focus = active.focus
  active = undefined
  if (focus?.isConnected) focus.focus({ preventScroll: true })
}
export function showServiceLoading(detail = 'Estamos preparando la siguiente pantalla.') {
  if (active) return
  const element = document.createElement('div')
  element.id = 'service-transition'; element.className = 'service-transition'
  const panel = document.createElement('div'); panel.className = 'service-transition-panel'
  const spinner = document.createElement('span'); spinner.className = 'service-transition-spinner'; spinner.setAttribute('aria-hidden', 'true')
  const status = document.createElement('div'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
  const title = document.createElement('strong'); title.textContent = 'Cargando servicios…'
  const text = document.createElement('p'); text.textContent = detail
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Recargar página'; cancel.hidden = true
  cancel.onclick = () => { window.stop(); finishServiceLoading(); location.reload() }
  status.append(title, text); panel.append(spinner, status, cancel); element.append(panel)
  const background = [...document.body.children].filter(item => item instanceof HTMLElement).map(item => [item, item.inert])
  const focus = document.activeElement
  background.forEach(([item]) => { item.inert = true }); document.body.append(element)
  panel.tabIndex = -1; panel.focus({ preventScroll: true })
  active = { element, background, focus, timer: setTimeout(() => { text.textContent = 'Está tardando más de lo habitual. Puedes esperar o recargar la página.'; cancel.hidden = false }, 12000) }
}
export function navigateWithLoading(action, detail) {
  if (active) return
  showServiceLoading(detail)
  const transition = active
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (active !== transition) return
    try { action() } catch { finishServiceLoading() }
  }))
}
export function installServiceLinks(navigate) {
  const handler = event => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    const link = event.target.closest?.('a[href]')
    if (!link || link.hasAttribute('download') || link.target && link.target !== '_self') return
    const url = new URL(link.href, location.href)
    if (!['http:', 'https:'].includes(url.protocol) || /\.(pdf|png|jpg|jpeg|webp|mp4|xlsx|zip)$/i.test(url.pathname)) return
    if (url.origin !== location.origin && !link.matches('.hub-module,.hub-return,.sidebar-hub-return')) return
    if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search) return
    event.preventDefault()
    navigateWithLoading(() => url.origin === location.origin ? navigate(url.pathname + url.search + url.hash) : location.assign(url.href))
  }
  document.addEventListener('click', handler, true)
  return () => document.removeEventListener('click', handler, true)
}
window.addEventListener('pageshow', finishServiceLoading)
