// «2021_S05» → «Semana 05 · 2021»; «sub/2021_S05» → «sub · Semana 05 · 2021».
export function weekLabel(path = '') {
  return String(path).split('/').filter(Boolean)
    .map(seg => seg.replace(/^(\d{4})_S(\d{2})$/, 'Semana $2 · $1')).join(' · ')
}
