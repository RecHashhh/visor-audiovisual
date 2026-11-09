import { Kpi } from './HardwareCard';
import { measureRows, periodYears, sum } from './metrics';
import { usd } from '../../components/charts/HardwareCharts';
import { hasInvoice } from './v3Metrics';

export const dateLabel = value => value ? new Date(value).toLocaleDateString('es-EC', {
  timeZone: 'America/Guayaquil', day: 'numeric', month: 'numeric',
}) : 'sin fecha';

// Tabla a la que lleva cada indicador: [sección, id de tabla] o filas propias.
function links(v, data) {
  const computers = state => ({ section: 'estado', title: state, rows: v.computers.filter(row => row.equipmentState === state) });
  return {
    'Equipos vigentes': { section: 'proyectos', title: 'Equipos vigentes', rows: data.active },
    'Computadoras vigentes': ['estado', 'computer-state'], 'Equipos comprados': ['compras', 'purchases'],
    'Inversión del período': ['compras', 'purchases'], 'Valor de compra': ['compras', 'purchases'],
    'Valor de compra dado de baja': ['bajas', 'disposals'], 'Cobertura de personal': ['personas', 'with-computer'],
    'Ahorro potencial al mes': ['licencias', 'accounts'], 'Ahorro potencial mensual': ['licencias', 'accounts'],
    'Ahorro potencial anual': ['licencias', 'accounts'], 'Licencias asignadas': ['licencias', 'accounts'],
    'Cuentas con actividad desconocida': ['licencias', 'inactive-accounts'],
    ...Object.fromEntries(['En uso', 'Backup / stock', 'En reparación', 'Con fallas', 'Sin asignar (bodega)',
      'Asignada a persona fuera de nómina'].map(state => [state, computers(state)])),
    'Estado físico registrado': ['estado', 'computer-state'], 'Compras sin factura': ['compras', 'without-invoice'],
    'Pedidos por entregar': ['compras', 'deliveries'], 'Entrega promedio · días': ['compras', 'deliveries'],
    'Valor sin asegurar': ['seguros', 'uninsured'], 'Garantías vencen en 90 días': ['seguros', 'warranty-expiring'],
    'Bajas': ['bajas', 'disposals'], 'Valor de compra perdido': ['bajas', 'disposals'],
    'Computadoras de 5 años o más': ['bajas', 'renewal'], 'Renovación estimada': ['bajas', 'renewal'],
    'Personal objetivo': ['personas', 'people'], 'Con computadora, sin licencia': ['personas', 'without-license'], 'Sin computadora': ['personas', 'without-computer'],
    'Con equipo y requisitos digitales pendientes': ['personas', 'people'], 'Computadoras a recuperar': ['personas', 'recover'],
    'Proyectos con equipos': ['proyectos', 'projects'], 'Valor de compra vigente': ['proyectos', 'assignments'],
    'Personal sin computadora': ['personas', 'without-computer'], 'Empresa registrada': ['calidad', 'invalid-company'],
    'Por activar en RIP_TIC': ['calidad', 'to-activate'],
  };
}

export default function SectionKpis({ tab, data, period, model, onOpen, canRecover = false }) {
  const v = model.v3, m = model.mesa;
  const map = links(v, data);
  const target = title => map[title] || (/^Pólizas vencen/.test(title) ? ['seguros', 'policies-expiring'] :
    tab === 'calidad' ? ['calidad', 'completeness'] : null);
  const opener = title => onOpen && target(title) ? () => onOpen(target(title)) : undefined;
  const current = (title, value, money = false, context, percent = false, tag) =>
    <Kpi key={title} title={title} value={value} money={money} context={context} percent={percent} onOpen={opener(title)} tag={tag} />;
  const years = periodYears(period);
  const when = years.length > 1 ? `${years[0]}–${years.at(-1)}` : years[0];
  const flow = (title, measure, money = false, context, tag) =>
    <Kpi title={title} rows={measureRows(data, measure, period)} period={period} money={money} context={context} onOpen={opener(title)} tag={tag} />;
  return <div className={`hw-kpis hw-kpis-exec${tab === 'estado' ? ' hw-kpis-seven' : ''}`}>
    {tab === 'resumen' && <>
      {/* Primero lo que pasó en el período elegido; después lo que existe hoy. */}
      {flow('Equipos comprados', 'equipment', false, undefined, when)}
      {flow('Inversión del período', 'value', true, undefined, when)}
      <Kpi title="Valor de compra dado de baja" rows={v.losses} period={period} money tag={when}
        context={`${measureRows(data, 'disposals', period).length.toLocaleString('es')} equipos dados de baja`}
        onOpen={opener('Valor de compra dado de baja')} />
      {current('Computadoras vigentes', v.computers.length, false,
        `de ${data.active.length.toLocaleString('es')} equipos · ${usd(sum(data.active, 'value'))}`, false, 'Hoy')}
      {current('Cobertura de personal', data.people.length ?
        100 * data.people.filter(p => p.statusKey !== 'sin_computadora').length / data.people.length : 0,
      false, 'del personal objetivo con computadora', true, 'Hoy')}
      {current('Ahorro potencial al mes', v.licenseScope.accountsAvailable ? v.licenses.monthly : null, true, undefined, false, 'Hoy')}
    </>}
    {tab === 'estado' && <>
      {['En uso', 'Backup / stock', 'En reparación', 'Con fallas', 'Sin asignar (bodega)',
        'Asignada a persona fuera de nómina'].map(state => current(state,
        v.computers.filter(row => row.equipmentState === state).length))}
      {current('Estado físico registrado', v.computers.length ? 100 * v.audited / v.computers.length : 0,
        false, `Última auditoría: ${v.lastAudit ? new Date(v.lastAudit).toLocaleDateString('es-EC') : 'sin fecha'}`, true)}
    </>}
    {tab === 'compras' && <>
      {flow('Equipos comprados', 'equipment')}{flow('Valor de compra', 'value', true)}
      {current('Compras sin factura', measureRows(data, 'equipment', period).filter(row => !hasInvoice(row)).length)}
      {m.deliveriesAvailable && current('Pedidos por entregar', m.openDeliveries, false, 'Pendientes o aprobados en la Mesa')}
      {m.deliveriesAvailable && current('Entrega promedio · días', m.averageDelivery === null ? null : Math.round(m.averageDelivery), false, 'Del pedido a la entrega')}
    </>}
    {tab === 'seguros' && <>
      {m.hasInsurance && <>
        {current('Equipos asegurados', m.insuredPercent, false, 'de los equipos vigentes, póliza al día', true)}
        {current('Valor sin asegurar', m.uninsuredValue, true, 'Valor de compra sin póliza vigente')}
        {[30, 60, 90].map((days, index) => current(`Pólizas vencen en ${days} días`, m.expiring[index]))}
      </>}
      {current('Garantías vencen en 90 días', m.warrantySoon)}
    </>}
    {tab === 'bajas' && <>
      {flow('Bajas', 'disposals')}
      <Kpi title="Valor de compra perdido" rows={v.losses} period={period} money onOpen={opener('Valor de compra perdido')} />
      {current('Computadoras de 5 años o más', v.renewal.rows.length)}
      {current('Renovación estimada', v.renewal.budget, true, v.renewal.average === null ?
        'Sin compras de laptop con costo para estimar' :
        `Laptop promedio ${v.renewal.year}: ${usd(v.renewal.average)}`)}
    </>}
    {tab === 'personas' && <>
      {current('Personal objetivo', data.people.length)}
      {current('Sin computadora', data.people.filter(p => p.statusKey === 'sin_computadora').length)}
      {current('Con computadora, sin licencia', data.people.filter(p => p.statusKey === 'sin_licencia').length)}
      {current('Con equipo y requisitos digitales pendientes', data.people.filter(p =>
        p.statusKey !== 'sin_computadora' && p.statusKey !== 'ok').length)}
      {canRecover && current('Computadoras a recuperar', v.computers.filter(row => row.equipmentState === 'Asignada a persona fuera de nómina').length)}
    </>}
    {tab === 'licencias' && <>
      {current('Licencias compradas', v.licenseScope.inventoryGlobal ? sum(v.licenseScope.paidStock, 'purchased') : null,
        false, v.licenseScope.inventoryGlobal ? undefined : 'Sin desglose para estos filtros')}
      {current('Licencias asignadas', !v.licenseScope.inventoryGlobal && !v.licenseScope.accountsAvailable ? null : sum(v.licenseScope.paidStock, 'assigned'))}
      {current('Licencias libres', v.licenseScope.inventoryGlobal ? sum(v.licenseScope.paidStock, 'available') : null,
        false, v.licenseScope.inventoryGlobal ? undefined : 'Sin desglose para estos filtros')}
      {current('Ahorro potencial mensual', v.licenseScope.accountsAvailable ? v.licenses.monthly : null, true)}
      {current('Ahorro potencial anual', v.licenseScope.accountsAvailable ? v.licenses.annual : null, true)}
      {current('Cuentas con actividad desconocida', v.licenseScope.accountsAvailable ? v.licenses.rows.filter(row => row.paidSkus.length && row.activity === 'Actividad desconocida').length : null)}
    </>}
    {tab === 'proyectos' && <>
      {current('Proyectos con equipos', new Set(data.active.map(row => row.project)).size)}
      {current('Equipos vigentes', data.active.length)}
      {current('Valor de compra vigente', sum(data.active, 'value'), true)}
      {current('Personal sin computadora', data.people.filter(p => p.statusKey === 'sin_computadora').length)}
    </>}
    {tab === 'calidad' && <>
      {model.companyQuality && current('Empresa registrada', model.companyQuality.percent, false,
        `${model.companyQuality.completed.toLocaleString('es')} de ${model.companyQuality.total.toLocaleString('es')} equipos`, true)}
      {current('Por activar en RIP_TIC', v.toActivate.length, false, 'Asignadas pero inactivas: cuentan como activas')}
      {[...v.quality].sort((a, b) => a.count - b.count).slice(0, 3).map(row => current(row.label, row.count, false,
        `Faltan ${row.missing.toLocaleString('es')} de ${row.total.toLocaleString('es')} computadoras`, true))}
    </>}
  </div>;
}
