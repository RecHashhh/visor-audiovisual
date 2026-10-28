// Configuración pública: determina la presentación; cada servidor autoriza el acceso.
const defaults = {
  helpdeskUrl: 'https://help.ripconciv.com',
  helpdeskEnabled: true,
  insuranceUrl: 'https://ripconciv-seguros-web-dcajb6cng8fkg3et.eastus-01.azurewebsites.net',
  insuranceEnabled: true,
  insuranceReviewEmails: ['dmesias@ripconciv.com', 'jmorales@ripconciv.com', 'gnaranjo@ripconciv.com'],
  insuranceReviewOids: ['46107a85-cfda-45fb-a058-ff32f1d8e9c9'],
}
export function insuranceEntry(settings = {}) {
  try {
    const url = new URL(settings.insuranceUrl || defaults.insuranceUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return `${url.origin}/api/auth/microsoft/start?entry=hub`
  } catch { return null }
}
export function availableModules(account, authorization, settings = {}) {
  const config = { ...defaults, ...settings }
  if (!account || !authorization || authorization.degraded || authorization.allowed !== true) return []
  const modules = []
  if (authorization.sections === '*' || Array.isArray(authorization.sections) && authorization.sections.length > 0) {
    modules.push({ id: 'audiovisual', title: 'Audiovisual', description: 'Fotografías de obra, videos, marcas y documentos corporativos.', href: '/audiovisual', external: false })
  }
  const email = String(account.username || '').trim().toLowerCase()
  const oid = String(account.idTokenClaims?.oid || '').toLowerCase()
  const emailAllowed = Array.isArray(config.insuranceReviewEmails) && config.insuranceReviewEmails.some(value => String(value).toLowerCase() === email)
  const oidAllowed = Array.isArray(config.insuranceReviewOids) && config.insuranceReviewOids.some(value => String(value).toLowerCase() === oid)
  const href = insuranceEntry(config)
  if (config.insuranceEnabled === true && href && (emailAllowed || oidAllowed)) modules.push({ id: 'insurance', title: 'Consulta de seguros', description: 'Consulta el personal asegurado, sus pólizas y vigencias.', href, external: true })
  return modules
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
