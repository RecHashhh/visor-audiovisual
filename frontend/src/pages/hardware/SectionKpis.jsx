import { Kpi } from './HardwareCard';
import { measureRows, sum } from './metrics';
import { usd } from '../../components/charts/HardwareCharts';
import { hasInvoice } from './v3Metrics';

export const dateLabel = value => value ? new Date(value).toLocaleDateString('es-EC', {
  timeZone: 'America/Guayaquil', day: 'numeric', month: 'numeric',
}) : 'sin fecha';

export default function SectionKpis({ tab, data, period, model }) {
  const v = model.v3, m = model.mesa;
  const current = (title, value, money = false, context, percent = false) =>
    <Kpi key={title} title={title} value={value} money={money} context={context} percent={percent} />;
  const flow = (title, measure, money = false) =>
    <Kpi title={title} rows={measureRows(data, measure, period)} period={period} money={money} />;
  return <div className={`hw-kpis hw-kpis-exec${['estado', 'resumen'].includes(tab) ? ' hw-kpis-seven' : ''}`}>
    {tab === 'resumen' && <>
      {current('Equipos vigentes', data.active.length, false, `${usd(sum(data.active, 'value'))} valor de compra`)}
      {current('Computadoras vigentes', v.computers.length)}
      {flow('Equipos comprados', 'equipment')}
      {flow('Inversión del período', 'value', true)}
      <Kpi title="Valor de compra dado de baja" rows={v.losses} period={period} money />
      {current('Cobertura de personal', data.people.length ?
        100 * data.people.filter(p => p.statusKey !== 'sin_computadora').length / data.people.length : 0,
      false, 'del personal objetivo con computadora', true)}
      {current('Ahorro potencial al mes', v.licenseScope.accountsAvailable ? v.licenses.monthly : null, true)}
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
      <Kpi title="Valor de compra perdido" rows={v.losses} period={period} money />
      {current('Computadoras de 5 años o más', v.renewal.rows.length)}
      {current('Renovación estimada', v.renewal.budget, true, v.renewal.average === null ?
        'Sin compras de laptop con costo para estimar' :
        `Laptop promedio ${v.renewal.year}: ${usd(v.renewal.average)}`)}
    </>}
    {tab === 'personas' && <>
      {current('Personal objetivo', data.people.length)}
      {current('Sin computadora', data.people.filter(p => p.statusKey === 'sin_computadora').length)}
      {current('Con equipo y requisitos digitales pendientes', data.people.filter(p =>
        p.statusKey !== 'sin_computadora' && p.statusKey !== 'ok').length)}
      {current('Computadoras a recuperar', v.computers.filter(row => row.equipmentState === 'Asignada a persona fuera de nómina').length)}
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
    {tab === 'calidad' && [...v.quality].sort((a, b) => b.missing - a.missing).slice(0, 3)
      .map(row => current(`Corregir: ${row.label}`, row.count, false,
        `${row.missing} computadoras con dato faltante o inconsistente`, true))}
  </div>;
}
