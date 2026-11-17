// Cierre mensual de computadores para Auditoría: une lo que sale de RIP_TIC (vía Mesa) con lo que TI completa a mano.
export const REPAIR_STATES = ['Pendiente', 'Retirado', 'Sin reparación'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export const monthLabel = month => {
  const [year, index] = String(month || '').split('-').map(Number);
  return MONTHS[index - 1] ? `${MONTHS[index - 1]} ${year}` : '';
};

/** Mes anterior al de hoy: el cierre se prepara a inicios del mes siguiente. */
export function previousMonth(today = new Date()) {
  const date = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// «2026-09-03» → «3/9/2026», como en el informe que se enviaba a Auditoría.
export const shortDate = value => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || '');
  return m ? `${Number(m[3])}/${Number(m[2])}/${m[1]}` : '';
};
const projectName = project => (project && typeof project === 'object' ? project.name || project.code : project) || '';
const money = value => (value == null || value === '' ? '' : Number(value).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export function closureRows(data, manual = {}) {
  const details = manual.repairs || {};
  const repairs = [
    ...(data?.repairs || []).map(row => {
      const extra = details[String(row.id).toUpperCase()] || {};
      return {
        ...row, key: row.id, source: 'RIP_TIC', project: projectName(row.project),
        reason: extra.reason || row.reason || '', estimate: extra.estimate || '', cost: extra.cost ?? null,
        // Sin estado elegido: retirado si ya volvió del proveedor dentro del mes.
        state: extra.state || (row.returnedAt ? 'Retirado' : 'Pendiente'),
      };
    }),
    ...(manual.extraRepairs || []).map(row => ({
      ...row, key: row.id, source: 'Manual', state: row.state || (row.returnedAt ? 'Retirado' : 'Pendiente'),
    })),
  ].sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt)) || String(a.code).localeCompare(String(b.code)));
  return {
    purchases: (data?.purchases || []).map(row => ({ ...row, holderProject: projectName(row.holderProject) })),
    repairs,
    reassignments: (data?.reassignments || []).map(row => ({
      ...row, previousProject: projectName(row.previousProject), project: projectName(row.project),
    })),
    disposals: (data?.disposals || []).map(row => ({ ...row, lastProject: projectName(row.lastProject) })),
    notes: manual.notes || '',
  };
}

// [clave, encabezado del informe, valor]: las mismas columnas en pantalla y en Word.
export const COLUMNS = {
  purchases: [
    ['type', 'Equipo'], ['code', 'Código'], ['brand', 'Marca'], ['model', 'Modelo'], ['serial', 'Serie'],
    ['purchaseDate', 'Fecha compra', r => shortDate(r.purchaseDate)], ['invoice', 'Factura'],
    ['supplier', 'Proveedor', r => r.supplier || r.supplierRuc || ''], ['value', 'Valor', r => money(r.value)],
    ['holderName', 'Custodio'], ['holderProject', 'Proyecto'],
  ],
  repairs: [
    ['type', 'Equipo'], ['code', 'Código'], ['name', 'Custodio'], ['reason', 'Motivo rep.'], ['supplier', 'Proveedor rep.'],
    ['sentAt', 'Fecha de envío', r => shortDate(r.sentAt)], ['estimate', 'Tiempo est. reparación'], ['state', 'Estado'],
    ['cost', 'Costo reparación', r => money(r.cost)], ['project', 'Último proyecto'],
  ],
  reassignments: [
    ['code', 'Código'], ['date', 'Fecha reasig.', r => shortDate(r.date)], ['previousName', 'Usuario previo'],
    ['previousProject', 'Proy. previo'], ['name', 'Usuario actual'], ['project', 'Proy. actual'],
  ],
  disposals: [
    ['type', 'Equipo'], ['code', 'Código'], ['brand', 'Marca'], ['location', 'Ubic. actual'], ['requestedBy', 'Responsable baja'],
    ['date', 'Fecha baja', r => shortDate(r.date)], ['reason', 'Motivo baja'], ['note', 'Observación'], ['lastName', 'Últ. custodio'],
    ['lastProject', 'Último proyecto'], ['purchaseDate', 'Fecha compra', r => shortDate(r.purchaseDate)],
  ],
};

export const SECTIONS = [
  ['purchases', 'Compras', 'COMPRAS EN EL MES', 'No existieron compras de computadores en el mes de'],
  ['repairs', 'Reparaciones', 'EQUIPOS EN MANTENIMIENTO - PROVEEDOR', 'No existieron equipos en reparación con proveedor en el mes de'],
  ['reassignments', 'Reasignaciones', 'REASIGNACIONES ENTRE EMPLEADOS EN PROYECTOS', 'No existieron reasignaciones en el mes de'],
  ['disposals', 'Bajas', 'BAJAS', 'No existieron bajas en el mes de'],
];

export const cell = (row, column) => String(column[2] ? column[2](row) : row[column[0]] ?? '');
