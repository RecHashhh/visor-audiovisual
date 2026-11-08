export function addCompanyQuality(model, quality) {
  const columns = [['code', 'Código'], ['type', 'Tipo'], ['registeredCompany', 'Empresa registrada'],
    ['ruc', 'RUC'], ['custodian', 'Custodio']];
  model.cards.calidad.push({ name: 'Empresa mal registrada', section: 'calidad', measure: 'v4',
    dimension: 'registeredCompany', kind: 'horizontal',
    chart: [...new Set(quality.invalid.map(row => row.registeredCompany))].map(label => ({ label,
      count: quality.invalid.filter(row => row.registeredCompany === label).length })),
    detailRows: quality.invalid, detailColumns: columns,
  });
  model.companyQuality = quality; // «Empresa registrada» va como KPI: un gráfico de una sola barra no aporta
  if (!model.tables.calidad.some(table => table.id === 'detail')) {
    model.tables.calidad.push({ id: 'invalid-company', title: 'Empresa mal registrada', rows: quality.invalid, columns });
  }
}
