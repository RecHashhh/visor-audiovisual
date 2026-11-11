// Configuración pública: determina la presentación; cada servidor autoriza el acceso.
const defaults = {
  helpdeskUrl: 'https://help.ripconciv.com',
  helpdeskEnabled: true,
  treasuryUrl: 'https://appweb-tesoreriaweb-ahend3bzcpecaffv.eastus-01.azurewebsites.net',
  treasuryEnabled: true,
  insuranceUrl: 'https://ripconciv-seguros-web-dcajb6cng8fkg3et.eastus-01.azurewebsites.net',
  insuranceEnabled: true,
}
export function insuranceEntry(settings = {}, account) {
  try {
    const url = new URL(settings.insuranceUrl || defaults.insuranceUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    const email = String(account?.username || '').trim()
    if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) url.searchParams.set('login_hint', email)
    url.searchParams.set('entry', 'hub')
    return `${url.origin}/api/auth/microsoft/start?${url.searchParams}`
  } catch { return null }
}
export function availableModules(account, authorization, settings = {}) {
  const config = { ...defaults, ...settings }
  if (!account || !authorization || authorization.degraded || authorization.allowed !== true) return []
  const modules = []
  if (authorization.sections === '*' || Array.isArray(authorization.sections) && authorization.sections.length > 0) {
    modules.push({ id: 'audiovisual', title: 'Audiovisual', description: 'Fotografías de obra, videos, marcas y documentos corporativos.', href: '/audiovisual', external: false })
  }
  if (authorization.caps?.hardware === true) {
    modules.push({ id: 'hardware', title: 'Hardware', description: 'Inventario de equipos, compras, bajas, licencias y seguros.', href: '/hardware', external: false })
  }
  const href = insuranceEntry(config, account)
  if (config.insuranceEnabled === true && href) modules.push({ id: 'insurance', title: 'Consulta de seguros', description: 'Consulta el personal asegurado, sus pólizas y vigencias.', href, external: true })
  const treasuryHref = treasuryEntry(config)
  if (config.treasuryEnabled === true && treasuryHref) modules.push({ id: 'treasury', title: 'Tesorería', description: 'Consulta facturas, propuestas y el flujo de pagos.', href: treasuryHref, external: true })
  return modules
}

export function treasuryEntry(settings = {}) {
  try {
    const url = new URL(settings.treasuryUrl || defaults.treasuryUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.origin + '/'
  } catch { return null }
}

export function helpdeskEntry(settings = {}) {
  try {
    const url = new URL(settings.helpdeskUrl || defaults.helpdeskUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.origin + '/api/auth/microsoft/start?entry=hub'
  } catch { return null }
}
export function helpdeskModule(settings = {}) {
  const config = { ...defaults, ...settings }
  const href = helpdeskEntry(config)
  return config.helpdeskEnabled === true && href ? { id: 'helpdesk', title: 'Mesa de Servicios TIC', description: 'Pide ayuda a Tecnología, sigue tus tickets y consulta manuales.', href, external: true } : null
}
