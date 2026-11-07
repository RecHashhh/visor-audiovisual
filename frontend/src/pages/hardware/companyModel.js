export function addCompanyQuality(model, quality) {
  const columns = [['code', 'Código'], ['type', 'Tipo'], ['registeredCompany', 'Empresa registrada'],
    ['ruc', 'RUC'], ['custodian', 'Custodio']];
  model.cards.calidad.push({ name: 'Empresa mal registrada', section: 'calidad', measure: 'v4',
    dimension: 'registeredCompany', kind: 'horizontal',
    chart: [...new Set(quality.invalid.map(row => row.registeredCompany))].map(label => ({ label,
      count: quality.invalid.filter(row => row.registeredCompany === label).length })),
    detailRows: quality.invalid, detailColumns: columns,
  });
  model.cards.calidad.push({ name: 'Campo empresa completado · %', section: 'calidad', measure: 'v4',
    dimension: 'label', kind: 'horizontal', max: 100,
    chart: [{ label: 'Empresa', count: quality.percent }],
    note: `${quality.completed} de ${quality.total} equipos con empresa registrada`,
    detailRows: [], detailColumns: columns,
  });
  if (!model.tables.calidad.some(table => table.id === 'detail')) {
    model.tables.calidad.push({ id: 'invalid-company', title: 'Empresa mal registrada', rows: quality.invalid, columns });
  }
}
