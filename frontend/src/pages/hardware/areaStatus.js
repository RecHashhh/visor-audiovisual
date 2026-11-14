export function areaStatus(snapshot) {
  const available = snapshot.hasAreas ?? (snapshot.payrollUploaded || (snapshot.coverage?.people ?? []).some(person => person.area));
  const source = snapshot.areaSource || (snapshot.payrollUploaded ? 'Excel' : 'Helpdesk');
  return { available: Boolean(available), tooltip: `Áreas: ${available ? source : 'sin clasificar'}. Helpdesk aplica excepciones por persona y cargo → área. El Excel de Hardware reemplaza esa fuente cuando se carga.` };
}
