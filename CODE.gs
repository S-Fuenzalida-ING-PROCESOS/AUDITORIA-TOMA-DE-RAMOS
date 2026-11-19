/****************************************************
 * AUDITORÍA TOMA DE RAMOS - v3 (script único)
 *
 * UNA SOLA ACCIÓN:  Menú "Auditoría" ▸ "Ejecutar auditoría completa"
 *
 * REPORTES DE ENTRADA (formato original de Banner, sin modificar):
 *   Importa cada archivo como hoja nueva (Archivo ▸ Importar ▸ Insertar
 *   hojas nuevas). El script reconoce cada reporte por su título, ignora las
 *   filas de título y, si hay varias hojas del mismo reporte, usa la más
 *   reciente según "Información obtenida al ...".
 *     - UG307 Ramos Inscritos por Periodo ... período a revisar (diario)
 *     - UG307 del verano anterior (año-1 + 65) ... SOLO si el período
 *       revisado termina en 10 (primer semestre)
 *     - RA311 Cumplimiento de Malla Pregrado
 *     - RA307 CAPP Adicional (opcional)
 *     - UG201 Listado de NRC por Periodo (del mismo período revisado)
 *     - UG101 Listado Alumnos Vigentes (opcional; fuente de CARRERA)
 *   Tablas internas: CATALOGO PE2027, CATALOGO PE2026, CATALOGO OLD,
 *   CATALOGO OLDER, ELECTIVOS.
 *
 * Planes de estudio (CONFIG_PLANES):
 *   - Catálogo >= 202710 ........ PE 2027 (hoja CATALOGO PE2027)
 *   - Catálogo 202610 - 202709 .. PE 2026 (hoja CATALOGO PE2026)
 *   - Catálogos anteriores ...... reglas por carrera (hoja CATALOGO OLD)
 *   Si una hoja de catálogo no existe, la auditoría no se detiene: los
 *   alumnos de ese plan se informan en ALERTAS y CODIGOS_NO_PRESENTES_EN_PLAN.
 *
 * Período a revisar: CONFIG_GENERAL ▸ PERIODO_REVISION (vacío = el período
 * más reciente no-verano presente en los UG307).
 *
 * Qué hace en una ejecución:
 *   1. Crea (si faltan) las hojas de configuración con valores por defecto.
 *   2. Determina el plan de estudios de cada alumno según CONFIG_PLANES.
 *   3. Valida cada inscripción: código correcto para su plan, pertenencia a
 *      su major, requisitos (RA311 + RA307 + equivalencias), SCT aprobados
 *      (cada curso cursado cuenta una vez) y electivos.
 *   4. Omite los cursos de EXCLUSIONES y clasifica los códigos restantes.
 *   5. Seguimiento diario (HISTORIAL_CASOS, CAMBIOS_DEL_DIA) conservando las
 *      columnas manuales de ALUMNOS_SIN_REQUISITOS.
 *   6. Escribe RESUMEN (incluye período, verano y reportes usados),
 *      NRC CORRECTOS, CONTROL_SCT y VALIDADOS_CAPP_ADICIONAL.
 ****************************************************/

/* =========================
   NOMBRES DE HOJAS
========================= */
const SH = {
  CUMPLIMIENTO: 'CUMPLIMIENTO MALLA',
  CAPP_ADICIONAL: 'CAPP ADICIONAL',
  RAMOS: 'RAMOS INSCRITOS',
  VERANO: 'RAMOS INSCRITOS VERANO',
  ELECTIVOS: 'ELECTIVOS',
  NRC: 'NRC POR PERIODO',

  CFG_PLANES: 'CONFIG_PLANES',
  CFG_GENERAL: 'CONFIG_GENERAL',
  CFG_EXCL: 'EXCLUSIONES',
  CFG_EQUIV: 'EQUIVALENCIAS',
  CFG_FLEX: 'LISTA_FLEXIBLE',

  OUT_MAIN: 'ALUMNOS_SIN_REQUISITOS',
  OUT_NOPLAN: 'CODIGOS_NO_PRESENTES_EN_PLAN',
  OUT_NRC: 'NRC CORRECTOS',
  OUT_CAMBIOS: 'CAMBIOS_DEL_DIA',
  OUT_RESUMEN: 'RESUMEN',
  OUT_CAPP: 'VALIDADOS_CAPP_ADICIONAL',
  OUT_SCT: 'CONTROL_SCT',

  HISTORIAL: 'HISTORIAL_CASOS',
  SNAP_ACTUAL: 'SNAPSHOT_INSCRITOS',
  SNAP_BASE: 'SNAPSHOT_INSCRITOS_BASE'
};

/* Columnas manuales que siempre existen en ALUMNOS_SIN_REQUISITOS.
   Cualquier otra columna que agregues a mano también se conserva. */
const MANUAL_COLS_DEFAULT = ['CAF/OBSERVACION', 'ESTADO'];

/* Carrera Banner -> columna de major en los catálogos */
const CARRERA_TO_MAJOR = {
  INGC: 'ICC', INGI: 'ICI', INGO: 'IOC', INGA: 'ICA', INGE: 'ICE', INGQ: 'ICQ'
};
const MAJOR_COLUMNS = ['ICC', 'ICI', 'IOC', 'ICA', 'ICE', 'ICQ'];

/* =========================
   CONFIGURACIÓN POR DEFECTO
   (solo se usa para crear las hojas si no existen;
    después se edita directamente en las hojas)
========================= */
const DEFAULT_CFG = {};

DEFAULT_CFG[SH.CFG_PLANES] = [
  ['CARRERA', 'CATALOGO_DESDE', 'CATALOGO_HASTA', 'PLAN_ID', 'FAMILIA', 'ETIQUETA_MENSAJE', 'HOJA_CATALOGO', 'PERMITE_CT', 'COMENTARIO'],
  ['*',    202710, 999999, 'PE2027',      'PE2027', 'PE 2027',                   'CATALOGO PE2027', 'NO', 'Regla global: todo catálogo >= 202710'],
  ['*',    202610, 202709, 'PE2026',      'PE2026', 'PE 2026',                   'CATALOGO PE2026', 'NO', 'Regla global: catálogo 202610 a 202709'],
  ['INGC', 202210, 202420, 'PE2022_ICC',  'OLD',    'PE 2022',                   'CATALOGO OLD',    'SI', ''],
  ['INGC', 202510, 202520, 'PE2025_ICC',  'OLD',    'PE 2025/2026',              'CATALOGO OLD',    'SI', ''],
  ['INGA', 202210, 202520, 'PE2022_ICA',  'OLD',    'PE 2022',                   'CATALOGO OLD',    'SI', ''],
  ['INGO', 202210, 202520, 'PE2022_IOC',  'OLD',    'PE 2022',                   'CATALOGO OLD',    'SI', ''],
  ['INGI', 202310, 202520, 'PE2023_ICI',  'OLD',    'PE 2023',                   'CATALOGO OLD',    'SI', ''],
  ['INGE', 202010, 202520, 'PE2020_ICE',  'OLD',    'PE 2020',                   'CATALOGO OLD',    'SI', ''],
  ['ING',  0,      202520, 'PC_ANTERIOR', 'OLD',    'Plan Común (plan anterior)', 'CATALOGO OLD',   'SI', 'Plan común con catálogo anterior a 202610: CONFIRMAR']
];

DEFAULT_CFG[SH.CFG_GENERAL] = [
  ['PARAMETRO', 'VALOR', 'DESCRIPCION'],
  ['PERIODO_REVISION', '', 'Período de toma de ramos a revisar (ej. 202710). Vacío = se toma del reporte UG307. Si termina en 10 se exige el UG307 del verano anterior (año-1 + 65).'],
  ['CATEGORIA_SOLICITUDES', 'Toma de Ramos 2026-20', 'Categoría de Banner (Comunicación Alumno Facultad) citada en el mensaje al estudiante'],
  ['FECHA_LIMITE_SOLICITUDES', 'jueves 06 de agosto', 'Plazo para solicitudes por canal alternativo, tal como aparece en el mensaje'],
  ['HOJAS_SOLO_EQUIVALENCIA', 'CATALOGO OLDER', 'Catálogos usados solo para reconocer equivalencias por título (separados por coma)'],
  ['PREFIJOS_INGENIERIA', 'ING,ICI,ICC,ICE,IOC,ICA,ICQ', 'Prefijos de cursos propios de la Facultad (para clasificar códigos no presentes)']
];

DEFAULT_CFG[SH.CFG_EXCL] = [
  ['TIPO', 'VALOR', 'CATEGORIA', 'COMENTARIO'],
  ['PREFIJO', 'CEG', 'Formación general', ''],
  ['PREFIJO', 'FRM', 'Formación general', ''],
  ['PREFIJO', 'ASM', 'Otra facultad / minor', ''],
  ['PREFIJO', 'EAM', 'Otra facultad / minor', ''],
  ['PREFIJO', 'PBM', 'Otra facultad / minor', ''],
  ['PREFIJO', 'CAM', 'Otra facultad / minor', ''],
  ['PREFIJO', 'MEM', 'Otra facultad / minor', ''],
  ['PREFIJO', 'NUM', 'Otra facultad / minor', ''],
  ['PREFIJO', 'PSM', 'Otra facultad / minor', ''],
  ['PREFIJO', 'KIM', 'Otra facultad / minor', ''],
  ['PREFIJO', 'TOM', 'Otra facultad / minor', ''],
  ['PREFIJO', 'PDM', 'Otra facultad / minor', ''],
  ['PREFIJO', 'DEM', 'Otra facultad / minor', ''],
  ['PREFIJO', 'ENM', 'Otra facultad / minor', ''],
  ['PREFIJO', 'HIM', 'Otra facultad / minor', ''],
  ['PREFIJO', 'EAD', 'Otra facultad / minor', ''],
  ['PREFIJO', 'CEM', 'Otra facultad / minor', ''],
  ['PREFIJO', 'ADM', 'Otra facultad / minor', ''],
  ['PREFIJO', 'FIM', 'Otra facultad / minor', ''],
  ['PREFIJO', 'LIM', 'Otra facultad / minor', ''],
  ['PREFIJO', 'ECN', 'Otra facultad / minor', ''],
  ['CODIGO',  'ING9000', 'Ramo matrícula', ''],
  ['CODIGO',  'ING9001', 'Ramo matrícula', '']
];

DEFAULT_CFG[SH.CFG_EQUIV] = [
  ['CODIGO_A', 'CODIGO_B', 'COMENTARIO']
];

DEFAULT_CFG[SH.CFG_FLEX] = [
  ['TITULO'],
  ['INTRODUCCIÓN A LA MECÁNICA'],
  ['TERMODINÁMICA'],
  ['ANÁLISIS DE CIRCUITOS'],
  ['CONTROL AUTOMÁTICO'],
  ['ELECTRÓNICA DE POTENCIA'],
  ['INTRODUCCIÓN A LAS COMUNICACIONES'],
  ['SEÑALES Y SISTEMAS'],
  ['SISTEMAS DIGITALES'],
  ['SISTEMAS ELECTRÓNICOS'],
  ['BALANCES DE MATERIA Y ENERGÍA'],
  ['EVALUACIÓN DE PROYECTOS DE INGENIERÍA AMBIENTAL'],
  ['FORMULACIÓN Y EVALUACIÓN DE PROYECTOS'],
  ['GESTIÓN AMBIENTAL Y PRODUCCIÓN LIMPIA'],
  ['GESTIÓN Y ADMINISTRACIÓN AMBIENTAL'],
  ['LEGISLACIÓN Y EVALUACIÓN DE IMPACTO AMBIENTAL'],
  ['LEGISLACIÓN LABORAL, SEGURIDAD E IMPACTO AMBIENTAL'],
  ['MÁQUINAS DE TRANSFORMACIÓN FÍSICA Y QUÍMICA'],
  ['MÁQUINAS DE TRANSFORMACIÓN']
];

/* =========================
   ENCABEZADOS DE SALIDA
========================= */
const MAIN_HEADERS_GENERATED = [
  'SEGUIMIENTO', 'PRIMERA DETECCION',
  'CARRERA', 'CATALOGO', 'PLAN DEL ALUMNO', 'NRC', 'NRC CORRECTO',
  'CODIGO INSCRITO', 'TITULO INSCRITO',
  'ISSUE_TYPE',
  'CODIGO_ESPERADO_PLAN', 'TITULO_ESPERADO_PLAN',
  'ELECTIVO_EN_POOL', 'ELECTIVO_PE', 'ELECTIVO_ESPECIALIDAD_OK',
  'EN LISTA FLEXIBLE', 'SCT APROBADOS',
  'REQUISITOS PLAN ALUMNO (RAW)', 'REQUISITOS PLAN ALTERNO (RAW)',
  'DETALLE INCUMPLIMIENTO FINAL', 'MENSAJE PARA ESTUDIANTE',
  'INFO VERANO', 'REQUISITOS FALTANTES (CODIGOS)', 'NOTAS EQUIVALENCIAS',
  'CASO_ID'
];

/* Columnas generadas por versiones anteriores: no se tratan como manuales. */
const LEGACY_GENERATED_HEADERS = [
  'MISSING_CODES_JSON', 'MISSING_TITLES_JSON', 'MISSING_CODES_ALT_JSON', 'MISSING_TITLES_ALT_JSON',
  'PASO2_CAPP_APROBADO', 'PASO2_CODIGO_ALTERNATIVO_APROBADO', 'PASO2_NOTAS', 'PRIMERA DETECCIÓN'
];

const HIST_HEADERS_FIXED = [
  'CASO_ID', 'RUT', 'CARRERA', 'PLAN DEL ALUMNO', 'NRC', 'CODIGO INSCRITO', 'TITULO INSCRITO',
  'ISSUE_TYPE', 'NRC CORRECTO', 'CODIGO_ESPERADO_PLAN',
  'ESTADO_CASO', 'PRIMERA_DETECCION', 'ULTIMA_DETECCION',
  'FECHA_RESOLUCION', 'MOTIVO_RESOLUCION', 'FECHA_REAPERTURA', 'CAMBIOS_ISSUE'
];

/* =========================
   MENÚ
========================= */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Auditoría')
    .addItem('▶ Ejecutar auditoría completa', 'ejecutarAuditoria')
    .addToUi();
}

/* =========================
   PUNTO DE ENTRADA ÚNICO
========================= */
function ejecutarAuditoria() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Ya hay una auditoría en ejecución. Intenta nuevamente en unos minutos.');
  }

  try {
    const t0 = Date.now();
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    const createdCfg = ensureConfigSheets_(ss);
    const ctx = loadContext_(ss);
    const result = analyze_(ctx);
    const tracking = applyTracking_(ss, ctx, result);

    writeMainOutput_(ss, result, tracking);
    writeNoPlanOutput_(ss, result);
    writeNrcCorrectosOutput_(ss, result);
    writeCambiosOutput_(ss, ctx, tracking);
    writeCappOutput_(ss, result);
    writeSctControlOutput_(ss, ctx);

    const secs = Math.round((Date.now() - t0) / 1000);
    writeResumenOutput_(ss, ctx, result, tracking, createdCfg, secs);

    ss.toast(
      `Casos abiertos: ${result.cases.length} · nuevos hoy: ${tracking.newToday} · ` +
      `resueltos hoy: ${tracking.resolvedToday} · ${secs}s`,
      'Auditoría completada',
      10
    );
  } finally {
    lock.releaseLock();
  }
}

/* =========================
   CONFIGURACIÓN
========================= */
function ensureConfigSheets_(ss) {
  const created = [];
  for (const name of [SH.CFG_PLANES, SH.CFG_GENERAL, SH.CFG_EXCL, SH.CFG_EQUIV, SH.CFG_FLEX]) {
    if (ss.getSheetByName(name)) continue;
    const values = DEFAULT_CFG[name];
    const sh = ss.insertSheet(name);
    sh.getRange(1, 1, values.length, values[0].length).setValues(values);
    sh.getRange(1, 1, 1, values[0].length).setFontWeight('bold');
    sh.setFrozenRows(1);
    created.push(name);
  }
  ensureGeneralParams_(ss);
  const migrated = ensurePlanRows_(ss);
  return created.concat(migrated);
}

/**
 * Agrega a CONFIG_PLANES los planes globales nuevos (p. ej. PE2027) que aún
 * no existan, y acota el rango de la regla global que hoy los cubre
 * (PE2026 hasta 999999 -> hasta 202709). No toca reglas por carrera.
 * Devuelve descripciones de los cambios para el RESUMEN.
 */
function ensurePlanRows_(ss) {
  const sh = ss.getSheetByName(SH.CFG_PLANES);
  const data = sh.getDataRange().getValues();
  const h = headerIndex_(data[0]);
  const cCar = h.get('CARRERA'), cDesde = h.get('CATALOGO_DESDE'), cHasta = h.get('CATALOGO_HASTA'), cId = h.get('PLAN_ID');
  if ([cCar, cDesde, cHasta, cId].some(x => x === undefined)) return [];

  const changes = [];
  const haveIds = new Set(data.slice(1).map(r => asText_(r[cId]).trim().toUpperCase()));
  const defaults = DEFAULT_CFG[SH.CFG_PLANES];
  const dh = headerIndex_(defaults[0]);

  for (const def of defaults.slice(1)) {
    const id = asText_(def[dh.get('PLAN_ID')]).trim().toUpperCase();
    if (def[dh.get('CARRERA')] !== '*' || haveIds.has(id)) continue;
    const desde = Number(def[dh.get('CATALOGO_DESDE')]);

    // Acotar reglas globales existentes que cubren el nuevo rango
    for (let i = 1; i < data.length; i++) {
      if (asText_(data[i][cCar]).trim() !== '*') continue;
      const d = toNumberStrict_(data[i][cDesde]);
      const hs = toNumberStrict_(data[i][cHasta]);
      if ((isNaN(d) || d < desde) && (isNaN(hs) || hs >= desde)) {
        sh.getRange(i + 1, cHasta + 1).setValue(desde - 1);
        changes.push(`${SH.CFG_PLANES}: ${asText_(data[i][cId])} ahora llega hasta ${desde - 1}`);
      }
    }

    // Nueva fila, respetando el orden de columnas de la hoja
    const row = data[0].map(name => {
      const j = dh.get(asText_(name).trim().toUpperCase());
      return j === undefined ? '' : def[j];
    });
    sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setValues([row]);
    changes.push(`${SH.CFG_PLANES}: se agregó el plan ${def[dh.get('PLAN_ID')]}`);
  }
  return changes;
}

/** Agrega a CONFIG_GENERAL los parámetros nuevos que aún no existan. */
function ensureGeneralParams_(ss) {
  const sh = ss.getSheetByName(SH.CFG_GENERAL);
  const data = sh.getDataRange().getValues();
  const have = new Set(data.map(r => asText_(r[0]).trim().toUpperCase()));
  const missing = DEFAULT_CFG[SH.CFG_GENERAL].slice(1).filter(r => !have.has(r[0]));
  if (missing.length) sh.getRange(data.length + 1, 1, missing.length, 3).setValues(missing);
}

function readGeneralConfig_(ss) {
  const data = mustGetSheet_(ss, SH.CFG_GENERAL).getDataRange().getValues();
  const map = new Map();
  for (let i = 1; i < data.length; i++) {
    const k = asText_(data[i][0]).trim().toUpperCase();
    if (k) map.set(k, asText_(data[i][1]).trim());
  }
  const get = (k, def) => (map.has(k) && map.get(k) !== '') ? map.get(k) : def;

  return {
    periodoRevision: get('PERIODO_REVISION', ''),
    categoriaSolicitudes: get('CATEGORIA_SOLICITUDES', 'Toma de Ramos'),
    fechaLimite: get('FECHA_LIMITE_SOLICITUDES', '(fecha por definir)'),
    hojasSoloEquivalencia: splitList_(get('HOJAS_SOLO_EQUIVALENCIA', '')),
    prefijosIngenieria: new Set(splitList_(get('PREFIJOS_INGENIERIA', 'ING,ICI,ICC,ICE,IOC,ICA,ICQ')).map(x => x.toUpperCase()))
  };
}

function readPlansConfig_(ss) {
  const data = mustGetSheet_(ss, SH.CFG_PLANES).getDataRange().getValues();
  const h = headerIndex_(data[0]);
  const c = {
    carrera: mustCol_(h, 'CARRERA'),
    desde: mustCol_(h, 'CATALOGO_DESDE'),
    hasta: mustCol_(h, 'CATALOGO_HASTA'),
    id: mustCol_(h, 'PLAN_ID'),
    familia: mustCol_(h, 'FAMILIA'),
    etiqueta: mustCol_(h, 'ETIQUETA_MENSAJE'),
    hoja: mustCol_(h, 'HOJA_CATALOGO'),
    ct: mustCol_(h, 'PERMITE_CT')
  };

  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    const id = asText_(r[c.id]).trim();
    if (!id) continue;
    const hoja = asText_(r[c.hoja]).trim();
    if (!hoja) throw new Error(`${SH.CFG_PLANES}: el plan ${id} no tiene HOJA_CATALOGO.`);
    rows.push({
      carrera: asText_(r[c.carrera]).trim().toUpperCase() || '*',
      desde: toNumberStrict_(r[c.desde]),
      hasta: toNumberStrict_(r[c.hasta]),
      id,
      familia: asText_(r[c.familia]).trim().toUpperCase(),
      etiqueta: asText_(r[c.etiqueta]).trim() || id,
      hoja,
      permiteCt: /^S/i.test(asText_(r[c.ct]).trim())
    });
  }
  if (!rows.length) throw new Error(`${SH.CFG_PLANES} no tiene planes configurados.`);
  return rows;
}

/** Plan de un alumno: primero reglas de su carrera, luego reglas "*". */
function resolvePlan_(plans, carrera, catalog) {
  const car = asText_(carrera).trim().toUpperCase();
  const cat = catalogNumber_(catalog);
  if (isNaN(cat)) return null;

  const fits = p =>
    (isNaN(p.desde) || cat >= p.desde) &&
    (isNaN(p.hasta) || cat <= p.hasta);

  for (const p of plans) if (p.carrera !== '*' && p.carrera === car && fits(p)) return p;
  for (const p of plans) if (p.carrera === '*' && fits(p)) return p;
  return null;
}

function readExclusions_(ss) {
  const data = mustGetSheet_(ss, SH.CFG_EXCL).getDataRange().getValues();
  const byCode = new Map();
  const byPrefix = [];
  for (let i = 1; i < data.length; i++) {
    const tipo = asText_(data[i][0]).trim().toUpperCase();
    const valor = cleanCode_(data[i][1]);
    const cat = asText_(data[i][2]).trim() || 'Excluido';
    if (!valor) continue;
    if (tipo.startsWith('COD')) byCode.set(valor, cat);
    else byPrefix.push({ prefix: valor, cat });
  }
  byPrefix.sort((a, b) => b.prefix.length - a.prefix.length);
  return { byCode, byPrefix };
}

function exclusionCategory_(excl, code) {
  if (excl.byCode.has(code)) return excl.byCode.get(code);
  for (const p of excl.byPrefix) if (code.startsWith(p.prefix)) return p.cat;
  return null;
}

function readEquivalencias_(ss) {
  const data = mustGetSheet_(ss, SH.CFG_EQUIV).getDataRange().getValues();
  const pairs = [];
  for (let i = 1; i < data.length; i++) {
    const a = cleanCode_(data[i][0]);
    const b = cleanCode_(data[i][1]);
    if (a && b && a !== b) pairs.push([a, b]);
  }
  return pairs;
}

function readFlexTitles_(ss) {
  const data = mustGetSheet_(ss, SH.CFG_FLEX).getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const t = asText_(data[i][0]).trim();
    if (t) out.push(t);
  }
  return out;
}

/* =========================
   CARGA DE DATOS
========================= */
function loadContext_(ss) {
  const now = runDate_();
  const todayKey = dateKey_(now);

  const general = readGeneralConfig_(ss);
  const plans = readPlansConfig_(ss);
  const excl = readExclusions_(ss);

  // Reportes de Banner en su formato original (o formato antiguo, como respaldo)
  const inputs = loadInputs_(ss, general);

  // Catálogos de los planes (uno por hoja, aunque varios planes la compartan)
  // Si falta una hoja, no se detiene la auditoría: sus alumnos se informan aparte.
  const catalogs = new Map();
  const missingCatalogs = new Map();   // hoja -> [PLAN_ID]
  for (const p of plans) {
    if (catalogs.has(p.hoja)) continue;
    const sh = ss.getSheetByName(p.hoja);
    if (!sh) {
      if (!missingCatalogs.has(p.hoja)) missingCatalogs.set(p.hoja, []);
      missingCatalogs.get(p.hoja).push(p.id);
      continue;
    }
    catalogs.set(p.hoja, buildCatalogIndex_(sh, p.hoja));
  }
  if (!catalogs.size) throw new Error(`${SH.CFG_PLANES}: no existe ninguna de las hojas de catálogo configuradas.`);
  for (const [hoja, ids] of missingCatalogs.entries()) {
    inputs.alerts.push(['CATALOGO NO CARGADO', hoja,
      `No existe la hoja "${hoja}" (plan ${ids.join(', ')}). Los alumnos de ese plan no se validan hasta agregarla.`]);
  }
  const planCatalogs = Array.from(catalogs.values());

  const equivOnly = [];
  for (const name of general.hojasSoloEquivalencia) {
    if (catalogs.has(name)) continue;
    const sh = ss.getSheetByName(name);
    if (sh) equivOnly.push(buildCatalogIndex_(sh, name));
  }

  const courseEquivalence = buildCourseEquivalenceIndex_(
    planCatalogs.concat(equivOnly),
    readEquivalencias_(ss)
  );

  const flexTitles = readFlexTitles_(ss);
  const flex = buildFlexIndex_(flexTitles, planCatalogs);

  const electivos = buildElectivosIndex_(mustGetSheet_(ss, SH.ELECTIVOS));
  const nrcIndex = buildNrcPorPeriodoIndex_(inputs.nrc, inputs.period);
  const cum = buildCumplimientoIndex_(inputs.cumplimiento);

  const extraApproved = inputs.capp ? buildCappApprovedIndex_(inputs.capp) : new Map();
  // CODIGO ALTERNATIVO (si la columna existe en el cumplimiento de malla)
  for (const [rut, codes] of cum.altApprovedByRut.entries()) {
    let m = extraApproved.get(rut);
    if (!m) { m = new Map(); extraApproved.set(rut, m); }
    for (const c of codes) if (!m.has(c)) m.set(c, 'CODIGO ALTERNATIVO');
  }

  // Carrera: UG101 (alumnos vigentes) si está disponible; si no, RA311.
  const carreraByRut = new Map(cum.carreraByRut);
  if (inputs.alumnos) {
    const h = headerIndex_(inputs.alumnos[0]);
    for (let i = 1; i < inputs.alumnos.length; i++) {
      const rut = cleanRut_(inputs.alumnos[i][h.get('RUT')]);
      const car = asText_(inputs.alumnos[i][h.get('CARRERA')]).trim();
      if (rut && car) carreraByRut.set(rut, car);
    }
  }

  const ramos = readEnrollments_(inputs.ramos);
  const verano = inputs.verano
    ? readEnrollments_(inputs.verano)
    : { rows: [], codesByRut: new Map(), nrcsByRut: new Map() };

  return {
    now, todayKey, general, plans, excl,
    catalogs, planCatalogs, courseEquivalence, flex,
    electivos, nrcIndex, cum, extraApproved, carreraByRut,
    ramos, verano,
    period: inputs.period,
    summerPeriod: inputs.summerPeriod,
    sources: inputs.sources,
    inputAlerts: inputs.alerts
  };
}

/** data: tabla canónica [encabezado, ...filas] (ver normalizeRamos_). */
function readEnrollments_(data) {
  const out = { rows: [], codesByRut: new Map(), nrcsByRut: new Map() };
  if (!data || data.length < 2) return out;

  const h = headerIndex_(data[0]);
  const cRut = h.get('RUT'), cCod = h.get('CODIGO'), cCat = h.get('CATALOGO');
  const cTit = h.get('TITULO'), cNrc = h.get('NRC');

  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    const rut = cleanRut_(r[cRut]);
    const code = cleanCode_(r[cCod]);
    if (!rut || !code) continue;

    const row = {
      rut,
      code,
      catalog: cleanCatalog_(r[cCat]),
      title: asText_(r[cTit]).trim(),
      nrc: cleanNrc_(r[cNrc])
    };
    out.rows.push(row);

    let s = out.codesByRut.get(rut);
    if (!s) { s = new Set(); out.codesByRut.set(rut, s); }
    s.add(code);

    let n = out.nrcsByRut.get(rut);
    if (!n) { n = new Set(); out.nrcsByRut.set(rut, n); }
    if (row.nrc) n.add(row.nrc);
  }
  return out;
}

/* =========================
   REPORTES DE ENTRADA (formato original Banner)
   - Se identifican por el código en el título (UG307, RA311, RA307,
     UG201, UG101), sin importar el nombre de la hoja.
   - El encabezado se busca automáticamente (las filas de título se ignoran).
   - Si hay varias hojas del mismo reporte, se usa la de fecha
     "Información obtenida al ..." más reciente.
   - Si no hay reporte original, se usan las hojas con formato antiguo
     (RAMOS INSCRITOS, CUMPLIMIENTO MALLA, etc.) como respaldo.
========================= */
const REPORTS = {
  UG307: { label: 'UG307 - Ramos Inscritos por Periodo', key: ['RUT', 'NRC'], legacy: [SH.RAMOS, SH.VERANO] },
  RA311: { label: 'RA311 - Cumplimiento de Malla', key: ['RUT', 'CREDITOS'], legacy: [SH.CUMPLIMIENTO] },
  RA307: { label: 'RA307 - CAPP Adicional', key: ['RUT', 'NOTA'], legacy: [SH.CAPP_ADICIONAL] },
  UG201: { label: 'UG201 - Listado de NRC por Periodo', key: ['NRC', 'PERIODO'], legacy: [SH.NRC] },
  UG101: { label: 'UG101 - Listado Alumnos Vigentes', key: ['RUT', 'CARRERA'], legacy: [] }
};

function loadInputs_(ss, general) {
  const alerts = [];
  const sources = [];
  const candidates = findReportSheets_(ss);

  const pick = code => {
    const list = candidates.filter(c => c.code === code).sort((a, b) => b.ts - a.ts);
    if (list.length > 1) {
      alerts.push(['REPORTE DUPLICADO', code,
        `Se usa "${list[0].sheet.getName()}" (${list[0].tsText}); se ignoran: ${list.slice(1).map(x => `"${x.sheet.getName()}"`).join(', ')}.`]);
    }
    if (list.length) return list[0];
    for (const name of REPORTS[code].legacy) {
      const sh = ss.getSheetByName(name);
      if (sh && sh.getLastRow() > 1) return { sheet: sh, code, ts: 0, tsText: 'formato antiguo', legacy: true };
    }
    return null;
  };

  const loadOne = (code, required, normalizer) => {
    const src = pick(code);
    if (!src) {
      if (required) throw new Error(`Falta el reporte ${REPORTS[code].label}. Importa el archivo original como una hoja nueva.`);
      sources.push([code, '(no disponible)', '', 0]);
      return null;
    }
    const t = readReportTable_(src.sheet, REPORTS[code].key);
    const data = normalizer(t);
    sources.push([code, src.sheet.getName(), src.tsText, data.length - 1]);
    return data;
  };

  /* --- UG307: inscripciones (período a revisar y, si corresponde, verano) --- */
  const ug307 = candidates.filter(c => c.code === 'UG307');
  if (!ug307.length) {
    for (const name of REPORTS.UG307.legacy) {
      const sh = ss.getSheetByName(name);
      if (sh && sh.getLastRow() > 1) ug307.push({ sheet: sh, code: 'UG307', ts: 0, tsText: 'formato antiguo', legacy: true });
    }
  }
  if (!ug307.length) throw new Error(`Falta el reporte ${REPORTS.UG307.label}.`);

  // Para cada período presente, la hoja más reciente que lo contiene.
  const byPeriod = new Map();   // período -> { src, rows }
  for (const src of ug307) {
    const data = normalizeRamos_(readReportTable_(src.sheet, REPORTS.UG307.key));
    const parts = new Map();
    for (let i = 1; i < data.length; i++) {
      const p = cleanCatalog_(data[i][5]);
      if (!parts.has(p)) parts.set(p, []);
      parts.get(p).push(data[i]);
    }
    for (const [p, rows] of parts.entries()) {
      const prev = byPeriod.get(p);
      if (!prev || src.ts > prev.src.ts) byPeriod.set(p, { src, rows, header: data[0] });
    }
  }

  let period = cleanCatalog_(general.periodoRevision);
  if (!period) {
    const regular = Array.from(byPeriod.keys()).filter(p => /^\d{6}$/.test(p) && !p.endsWith('65')).sort();
    period = regular.length ? regular[regular.length - 1] : '';
  }
  if (!/^\d{6}$/.test(period)) {
    throw new Error('No fue posible determinar el período a revisar. Indícalo en CONFIG_GENERAL (PERIODO_REVISION).');
  }
  const main = byPeriod.get(period);
  if (!main) {
    throw new Error(`No hay inscripciones del período ${period} en los reportes UG307 disponibles ` +
      `(períodos encontrados: ${Array.from(byPeriod.keys()).join(', ') || 'ninguno'}).`);
  }
  const ramos = [main.header].concat(main.rows);
  sources.push([`UG307 (${period})`, main.src.sheet.getName(), main.src.tsText, main.rows.length]);

  // Verano: solo para la toma de ramos de primer semestre (período terminado en 10).
  let verano = null;
  let summerPeriod = '';
  if (period.endsWith('10')) {
    summerPeriod = `${Number(period.slice(0, 4)) - 1}65`;
    const s = byPeriod.get(summerPeriod);
    if (!s) {
      throw new Error(`El período ${period} es de primer semestre y requiere el reporte UG307 del verano ${summerPeriod}. ` +
        'Importa ese reporte como una hoja nueva y vuelve a ejecutar.');
    }
    verano = [s.header].concat(s.rows);
    sources.push([`UG307 (${summerPeriod}, verano)`, s.src.sheet.getName(), s.src.tsText, s.rows.length]);
  }

  /* --- Resto de reportes --- */
  const cumplimiento = loadOne('RA311', true, normalizeCumplimiento_);
  const capp = loadOne('RA307', false, normalizeCapp_);
  const nrc = loadOne('UG201', true, normalizeNrc_);
  const alumnos = loadOne('UG101', false, normalizeAlumnos_);

  // UG201 debe corresponder al período revisado.
  const nrcPeriods = new Set();
  for (let i = 1; i < nrc.length; i++) { const p = cleanCatalog_(nrc[i][5]); if (p) nrcPeriods.add(p); }
  if (nrcPeriods.size && !nrcPeriods.has(period)) {
    alerts.push(['UG201 DE OTRO PERIODO', Array.from(nrcPeriods).join(', '),
      `El listado de NRC corresponde a ${Array.from(nrcPeriods).join(', ')} y se revisa ${period}: no se calculará NRC CORRECTO hasta importar el UG201 de ${period}.`]);
  }

  return { period, summerPeriod, ramos, verano, cumplimiento, capp, nrc, alumnos, sources, alerts };
}

/** Busca hojas cuyo título (primeras filas) contiene el código de un reporte. */
function findReportSheets_(ss) {
  const skip = new Set(Object.values(SH));
  const out = [];
  for (const sh of ss.getSheets()) {
    const name = sh.getName();
    if (skip.has(name)) continue;
    const lastRow = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    if (lastRow < 2 || lastCol < 1) continue;

    const top = sh.getRange(1, 1, Math.min(10, lastRow), Math.min(5, lastCol)).getValues();
    let code = '';
    let tsText = '';
    for (const row of top) {
      for (const cell of row) {
        const txt = asText_(cell);
        const m = txt.match(/\b(UG307|RA311|RA307|UG201|UG101)\b/);
        if (m && !code) {
          code = m[1];
          const t = txt.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
          if (t) tsText = t[0];
        }
      }
    }
    if (!code) continue;

    let ts = 0;
    const t = tsText.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (t) ts = new Date(+t[3], +t[2] - 1, +t[1], +t[4], +t[5], +(t[6] || 0)).getTime();
    out.push({ sheet: sh, code, ts, tsText: tsText || '(sin fecha)', legacy: false });
  }
  return out;
}

/** Lee una hoja y ubica la fila de encabezado (la primera que contiene todas las columnas clave). */
function readReportTable_(sheet, keyHeaders) {
  const values = sheet.getDataRange().getValues();
  const keys = keyHeaders.map(k => k.toUpperCase());
  let hr = -1;
  for (let i = 0; i < Math.min(30, values.length); i++) {
    const set = new Set(values[i].map(x => asText_(x).trim().toUpperCase()));
    if (keys.every(k => set.has(k))) { hr = i; break; }
  }
  if (hr < 0) throw new Error(`Hoja "${sheet.getName()}": no se encontró la fila de encabezado (${keyHeaders.join(', ')}).`);
  return { name: sheet.getName(), header: values[hr].map(x => asText_(x).trim()), rows: values.slice(hr + 1) };
}

/* ---- Normalizadores: llevan cada reporte a columnas canónicas ---- */
function colGetter_(t) {
  const h = headerIndex_(t.header);
  return {
    has: (...names) => findColOneOf_(h, names) !== null,
    idx: (...names) => findColOneOf_(h, names),
    get: (row, ...names) => {
      const i = findColOneOf_(h, names);
      return i === null ? '' : row[i];
    }
  };
}

function codeFromMateriaCurso_(materia, curso) {
  const m = asText_(materia).trim().toUpperCase();
  let c = asText_(curso).trim().toUpperCase();
  if (c.endsWith('.0')) c = c.slice(0, -2);
  if (/^\d{1,3}$/.test(c)) c = c.padStart(4, '0');   // conserva ceros (ICI0230)
  return m && c ? m + c : '';
}

function isRowEmpty_(row) {
  return !row.some(v => asText_(v).trim() !== '');
}

/** UG307 -> RUT, CODIGO, CATALOGO, TITULO, NRC, PERIODO INSCRIPCION */
function normalizeRamos_(t) {
  const g = colGetter_(t);
  const out = [['RUT', 'CODIGO', 'CATALOGO', 'TITULO', 'NRC', 'PERIODO INSCRIPCION']];
  for (const r of t.rows) {
    if (isRowEmpty_(r)) continue;
    const code = g.has('CODIGO') ? g.get(r, 'CODIGO') : codeFromMateriaCurso_(g.get(r, 'MATERIA'), g.get(r, 'CURSO'));
    out.push([
      g.get(r, 'RUT'),
      cleanCode_(code),
      g.get(r, 'CATALOGO', 'PER. CATALOGO', 'PERIODO CATALOGO'),
      g.get(r, 'TITULO', 'ASIGNATURA'),
      g.get(r, 'NRC'),
      cleanCatalog_(g.get(r, 'PERIODO INSCRIPCION'))
    ]);
  }
  return out;
}

/**
 * RA311 -> RUT, CODIGO, ESTADO CURSO, CREDITOS, CARRERA, PERIODO CURSADO,
 *          NRC, TITULO ALTERNATIVO, CODIGO ALTERNATIVO
 * Formato original: CODIGO = REGLA; ESTADO CURSO = APROBADO si la regla tiene
 * un curso aplicado (período/NRC/nota/origen), DEBE si está vacía;
 * TITULO = título del curso efectivamente cursado.
 */
function normalizeCumplimiento_(t) {
  const g = colGetter_(t);
  const original = g.has('DESCRIPCION REGLA');
  const out = [['RUT', 'CODIGO', 'ESTADO CURSO', 'CREDITOS', 'CARRERA', 'PERIODO CURSADO', 'NRC', 'TITULO ALTERNATIVO', 'CODIGO ALTERNATIVO']];

  for (const r of t.rows) {
    if (isRowEmpty_(r)) continue;
    const code = g.has('CODIGO') ? g.get(r, 'CODIGO') : g.get(r, 'REGLA');

    let estado;
    if (g.has('ESTADO CURSO')) {
      estado = g.get(r, 'ESTADO CURSO');
    } else {
      const per = asText_(g.get(r, 'PERIODO CURSADO')).trim();
      const nrc = asText_(g.get(r, 'NRC')).trim();
      const nota = asText_(g.get(r, 'NOTA')).trim();
      const origen = asText_(g.get(r, 'ORIGEN')).trim();
      if (!per && !nrc && !nota && !origen) estado = 'DEBE';
      else {
        const n = toNumberStrict_(nota.replace(',', '.'));
        estado = (!isNaN(n) && n < 4) ? 'REPROBADO' : 'APROBADO';
      }
    }

    out.push([
      g.get(r, 'RUT'),
      cleanCode_(code),
      asText_(estado).trim().toUpperCase(),
      g.get(r, 'CREDITOS', 'CRÉDITOS', 'CREDITO', 'CRÉDITO'),
      g.get(r, 'CARRERA', 'CARRERA BANNER 2026', 'CARRERA BANNER'),
      g.get(r, 'PERIODO CURSADO'),
      g.get(r, 'NRC'),
      original ? g.get(r, 'TITULO') : g.get(r, 'TITULO ALTERNATIVO'),
      g.get(r, 'CODIGO ALTERNATIVO', 'CÓDIGO ALTERNATIVO', 'CODIGO_ALTERNATIVO')
    ]);
  }
  return out;
}

/** RA307 -> RUT, CODIGO, ESTADO CURSO (APROBADO si nota >= 4,0 o APR). */
function normalizeCapp_(t) {
  const g = colGetter_(t);
  const out = [['RUT', 'CODIGO', 'ESTADO CURSO']];
  for (const r of t.rows) {
    if (isRowEmpty_(r)) continue;
    const code = g.has('CODIGO') ? g.get(r, 'CODIGO') : codeFromMateriaCurso_(g.get(r, 'MATERIA'), g.get(r, 'CURSO'));
    let estado = g.has('ESTADO CURSO') ? asText_(g.get(r, 'ESTADO CURSO')).trim().toUpperCase() : '';
    if (!estado) {
      const nota = asText_(g.get(r, 'NOTA')).trim().toUpperCase();
      const n = toNumberStrict_(nota.replace(',', '.'));
      estado = (nota === 'APR' || (!isNaN(n) && n >= 4)) ? 'APROBADO' : 'REPROBADO';
    }
    out.push([g.get(r, 'RUT'), cleanCode_(code), estado]);
  }
  return out;
}

/** UG201 -> NRC, CODIGO, LISTA CRUZADA, SECC., TIPO, PERIODO */
function normalizeNrc_(t) {
  const g = colGetter_(t);
  const out = [['NRC', 'CODIGO', 'LISTA CRUZADA', 'SECC.', 'TIPO', 'PERIODO']];
  for (const r of t.rows) {
    if (isRowEmpty_(r)) continue;
    const code = g.has('CODIGO') ? g.get(r, 'CODIGO') : codeFromMateriaCurso_(g.get(r, 'MATERIA'), g.get(r, 'CURSO'));
    out.push([
      g.get(r, 'NRC'),
      cleanCode_(code),
      g.get(r, 'LISTA CRUZADA', 'LC'),
      g.get(r, 'SECC.', 'SECC', 'SECCION', 'SECCIÓN'),
      g.get(r, 'TIPO', 'TIPO DE REUNION', 'TIPO DE REUNIÓN'),
      cleanCatalog_(g.get(r, 'PERIODO'))
    ]);
  }
  return out;
}

/** UG101 -> RUT, CARRERA, PERIODO CATALOGO */
function normalizeAlumnos_(t) {
  const g = colGetter_(t);
  const out = [['RUT', 'CARRERA', 'PERIODO CATALOGO']];
  for (const r of t.rows) {
    if (isRowEmpty_(r)) continue;
    out.push([g.get(r, 'RUT'), g.get(r, 'CARRERA'), g.get(r, 'PERIODO CATALOGO')]);
  }
  return out;
}

/* =========================
   ANÁLISIS PRINCIPAL
========================= */
function analyze_(ctx) {
  const cases = [];          // ALUMNOS_SIN_REQUISITOS
  const noPlan = [];         // CODIGOS_NO_PRESENTES_EN_PLAN
  const nrcRows = [];        // NRC CORRECTOS
  const cappValidated = [];  // VALIDADOS_CAPP_ADICIONAL
  const excludedCount = new Map();
  const alerts = ctx.inputAlerts.slice();
  const alertedRuts = new Set();
  const seenCase = new Set();

  const { plans, catalogs, planCatalogs, cum } = ctx;

  for (const en of ctx.ramos.rows) {
    const rut = en.rut;
    const code = en.code;
    const carrera = (ctx.carreraByRut.get(rut) || '').trim();

    if (!cum.statusByRut.has(rut) && !alertedRuts.has(rut + '|CUM')) {
      alertedRuts.add(rut + '|CUM');
      alerts.push(['ALUMNO SIN CUMPLIMIENTO MALLA', rut, `Catálogo ${en.catalog}. Sus requisitos se evalúan sin historial académico.`]);
    }

    const plan = resolvePlan_(plans, carrera, en.catalog);
    const exclCat = exclusionCategory_(ctx.excl, code);

    if (!plan) {
      if (!alertedRuts.has(rut + '|PLAN')) {
        alertedRuts.add(rut + '|PLAN');
        alerts.push(['PLAN NO CONFIGURADO', rut, `CARRERA="${carrera || '(vacía)'}", CATALOGO=${en.catalog || '(vacío)'}. Agregar regla en ${SH.CFG_PLANES}.`]);
      }
      if (exclCat) { incMap_(excludedCount, exclCat); continue; }
      noPlan.push(noPlanRow_(en, carrera, '(sin plan)', `Plan de estudios no configurado (CARRERA=${carrera || '(vacía)'}, CATALOGO=${en.catalog})`));
      continue;
    }

    const planCatalog = catalogs.get(plan.hoja);
    if (!planCatalog) {
      if (exclCat) { incMap_(excludedCount, exclCat); continue; }
      noPlan.push(noPlanRow_(en, carrera, plan.id, `Catálogo "${plan.hoja}" no cargado: no se validó la inscripción`));
      continue;
    }
    const otherCatalogs = planCatalogs.filter(c => c !== planCatalog);

    const student = {
      rut, carrera, plan,
      status: cum.statusByRut.get(rut) || new Map(),
      extra: ctx.extraApproved.get(rut) || new Map(),
      enrolled: ctx.ramos.codesByRut.get(rut) || new Set(),
      verano: ctx.verano.codesByRut.get(rut) || new Set(),
      sct: cum.sctByRut.get(rut) || 0
    };

    const inFlex = isFlexibleCourse_(code, en.title, ctx.flex);
    const existsInAny = planCatalogs.some(c => c.codeToReq.has(code));

    const base = {
      rut, carrera, catalogo: en.catalog, plan: plan.id, planObj: plan,
      nrc: en.nrc, nrcCorrecto: '', codigo: code, titulo: en.title,
      issue: '', codEsperado: '', titEsperado: '',
      elecPool: 'NO', elecPe: '', elecEspOk: '',
      flex: inFlex ? 'SI' : 'NO', sct: Math.floor(student.sct),
      reqAlumno: '', reqAlterno: '', detalle: '', infoVerano: '',
      faltantes: '', notas: ''
    };

    const pushCase = c => {
      c.id = caseId_(c.rut, c.nrc, c.codigo);
      if (seenCase.has(c.id)) return;   // filas duplicadas en RAMOS INSCRITOS
      seenCase.add(c.id);
      cases.push(c);
    };

    /* ---- Caso 0: código fuera de todos los catálogos de plan ---- */
    if (!existsInAny) {
      const elec = ctx.electivos.byCode.get(code);
      if (elec) {
        const peOk = electivePeAllows_(elec.pe, plan, ctx.plans);
        const espOk = electiveEspecialidadAllows_(elec.especialidades, carrera);
        if (peOk && espOk) continue;

        pushCase(Object.assign({}, base, {
          issue: 'ELECTIVO_NO_PERMITIDO',
          elecPool: 'SI',
          elecPe: Array.from(elec.pe).join(','),
          elecEspOk: espOk ? 'SI' : 'NO',
          detalle: buildElectivoNoPermitidoMsg_(code, elec, peOk, espOk, plan, carrera)
        }));
        continue;
      }

      if (exclCat) { incMap_(excludedCount, exclCat); continue; }

      noPlan.push(noPlanRow_(en, carrera, plan.id, classifyUnknownCode_(code, ctx.general)));
      continue;
    }

    /* ---- Código no existe en el catálogo del plan del alumno ---- */
    if (!planCatalog.codeToReq.has(code)) {
      const eqCandidates = findEquivalentCandidatesInPlanByTitle_(en.title, planCatalog);

      if (eqCandidates.length === 0) {
        noPlan.push(noPlanRow_(en, carrera, plan.id, 'Código no existe en su plan y no se encontró equivalente por título'));
        continue;
      }

      let eq = null;
      let firstRejected = null;
      for (const cand of eqCandidates) {
        const chk = courseAllowedForCarrera_(planCatalog, cand, carrera, plan);
        if (chk.allowed) { eq = { code: cand, chk }; break; }
        if (!firstRejected) firstRejected = { code: cand, chk };
      }

      if (!eq) {
        const rejectedCode = firstRejected ? firstRejected.code : eqCandidates[0];
        const reason = firstRejected ? firstRejected.chk.reason : `Ningún equivalente por título pertenece a la carrera ${carrera}.`;
        pushCase(Object.assign({}, base, {
          issue: 'CURSO_NO_PERTENECE_A_SU_PLAN',
          codEsperado: rejectedCode,
          titEsperado: planCatalog.codeToTitle.get(rejectedCode) || en.title,
          detalle: `El código inscrito ${code} no existe en el plan ${plan.id}. ` +
            `Se encontró el equivalente ${rejectedCode} por título, pero ${reason}`
        }));
        continue;
      }

      const reqEqRaw = asText_(planCatalog.codeToReq.get(eq.code)).trim();
      const nrcInfo = findEquivalentNrc_(en.nrc, eq.code, ctx.nrcIndex);

      if (!reqEqRaw) {
        // Sin requisitos: el único problema es el código.
        const c = Object.assign({}, base, {
          issue: 'CODIGO_PLAN_INCORRECTO',
          codEsperado: eq.code,
          titEsperado: planCatalog.codeToTitle.get(eq.code) || en.title,
          nrcCorrecto: nrcInfo.nrc || nrcInfo.status,
          detalle: `Se inscribió en ${code}; su plan ${plan.id} usa ${eq.code} (sin requisitos en catálogo).`
        });
        pushCase(c);
        nrcRows.push(nrcRow_(c, nrcInfo));
        continue;
      }

      const ev = evaluatePrereqs_({
        courseCode: eq.code, reqRaw: reqEqRaw, student,
        mainCatalog: planCatalog, fallbackCatalogs: otherCatalogs,
        courseEquivalence: ctx.courseEquivalence
      });

      if (ev.cumple) {
        const c = Object.assign({}, base, {
          issue: 'CODIGO_PLAN_INCORRECTO',
          codEsperado: eq.code,
          titEsperado: planCatalog.codeToTitle.get(eq.code) || en.title,
          nrcCorrecto: nrcInfo.nrc || nrcInfo.status,
          reqAlumno: reqEqRaw,
          detalle: buildCodigoIncorrectoCumpleMsg_(eq.code, plan.id, code, ev.equivalenceNotes),
          notas: ev.equivalenceNotes.join(' | ')
        });
        pushCase(c);
        nrcRows.push(nrcRow_(c, nrcInfo));
        continue;
      }

      const c = Object.assign({}, base, {
        issue: 'CODIGO_PLAN_INCORRECTO_Y_FALTAN_REQUISITOS',
        codEsperado: eq.code,
        titEsperado: planCatalog.codeToTitle.get(eq.code) || en.title,
        reqAlumno: reqEqRaw,
        detalle: `Su plan sugiere ${eq.code} pero se inscribió en ${code}. Faltan requisitos para ${eq.code}: ${ev.detalle}`,
        infoVerano: buildVeranoInfo_(ev.missingByAlt, student.verano),
        faltantes: extractMissingCodes_(ev.missingByAlt).join(', '),
        notas: ev.equivalenceNotes.join(' | ')
      });
      pushCase(c);
      nrcRows.push(nrcRow_(c, nrcInfo));
      continue;
    }

    /* ---- Código existe en su plan: validar major ---- */
    const majorChk = courseAllowedForCarrera_(planCatalog, code, carrera, plan);
    if (!majorChk.allowed) {
      pushCase(Object.assign({}, base, {
        issue: 'CURSO_NO_PERTENECE_A_SU_PLAN',
        detalle: majorChk.reason
      }));
      continue;
    }

    /* ---- Caso normal: requisitos ---- */
    const reqRaw = asText_(planCatalog.codeToReq.get(code)).trim();
    if (!reqRaw) continue;

    const ev = evaluatePrereqs_({
      courseCode: code, reqRaw, student,
      mainCatalog: planCatalog, fallbackCatalogs: otherCatalogs,
      courseEquivalence: ctx.courseEquivalence
    });

    if (ev.cumple) {
      if (ev.extraSources.length) cappValidated.push(cappRow_(en, carrera, plan, code, ev.extraSources));
      continue;
    }

    // Cursos flexibles: se acepta si cumple los requisitos de algún otro plan.
    let reqAltRaw = '';
    let evAlt = null;
    if (inFlex) {
      for (const altCat of otherCatalogs) {
        const look = getAltPlanRequisitos_(code, en.title, altCat);
        const raw = asText_(look.reqRaw).trim();
        if (!raw) continue;
        const e = evaluatePrereqs_({
          courseCode: look.altCodeForDisplay || code, reqRaw: raw, student,
          mainCatalog: altCat, fallbackCatalogs: planCatalogs.filter(c => c !== altCat),
          courseEquivalence: ctx.courseEquivalence
        });
        if (!reqAltRaw) { reqAltRaw = raw; evAlt = e; }
        if (e.cumple) { evAlt = e; reqAltRaw = raw; break; }
      }
      if (evAlt && evAlt.cumple) {
        if (evAlt.extraSources.length) cappValidated.push(cappRow_(en, carrera, plan, code, evAlt.extraSources));
        continue;
      }
    }

    const infoVerano = combineInfo_(
      buildVeranoInfo_(ev.missingByAlt, student.verano),
      evAlt ? buildVeranoInfo_(evAlt.missingByAlt, student.verano) : '',
      'Alterno'
    );

    pushCase(Object.assign({}, base, {
      issue: 'REQUISITOS_FALTANTES',
      reqAlumno: reqRaw,
      reqAlterno: reqAltRaw,
      detalle: evAlt
        ? `Plan alumno: ${ev.detalle} ; Plan alterno: ${evAlt.detalle}`
        : `Plan alumno: ${ev.detalle}`,
      infoVerano,
      faltantes: extractMissingCodes_(ev.missingByAlt).join(', '),
      notas: ev.equivalenceNotes.join(' | ')
    }));
  }

  // Mensaje al estudiante
  for (const c of cases) {
    c.mensaje = (c.issue === 'REQUISITOS_FALTANTES' || c.issue === 'CODIGO_PLAN_INCORRECTO_Y_FALTAN_REQUISITOS')
      ? buildStudentMissingPrereqsMessage_(c, ctx.general)
      : '';
  }

  return { cases, noPlan, nrcRows, cappValidated, excludedCount, alerts };
}

function caseId_(rut, nrc, code) {
  return `${cleanRut_(rut)}|${cleanNrc_(nrc)}|${cleanCode_(code)}`;
}

function noPlanRow_(en, carrera, planId, motivo) {
  return { rut: en.rut, carrera, catalogo: en.catalog, plan: planId, nrc: en.nrc, codigo: en.code, titulo: en.title, motivo };
}

function cappRow_(en, carrera, plan, code, sources) {
  return [en.rut, carrera, plan.id, en.nrc, code, en.title, unique_(sources).join(' | ')];
}

function classifyUnknownCode_(code, general) {
  const m = code.match(/^([A-Z]+)(\d+)/);
  const prefix = m ? m[1] : code.slice(0, 3);
  const num = m ? m[2] : '';
  if (general.prefijosIngenieria.has(prefix)) {
    return num.startsWith('0')
      ? 'ELECTIVO NO REGISTRADO EN ELECTIVOS'
      : 'CODIGO DE INGENIERIA NO PRESENTE EN CATALOGOS';
  }
  return `Prefijo ${prefix} sin clasificar (agregar a ${SH.CFG_EXCL} si corresponde)`;
}

/* =========================
   MENSAJES
========================= */
function buildStudentMissingPrereqsMessage_(c, general) {
  const planLabel = `${c.planObj.etiqueta}${c.catalogo ? ` (catálogo ${c.catalogo})` : ''}`;
  const enrolledTitle = c.titulo || '(sin título informado)';
  const enrolledCode = c.codigo || '(sin código informado)';
  const enrolledNrc = c.nrc || '(sin NRC informado)';
  const reqMain = c.reqAlumno || '(sin detalle de requisitos en catálogo)';
  const why = buildNaturalMissingPrereqsExplanation_(c.detalle);

  return [
    'Estimado/a estudiante:',
    '',
    'Junto con saludar, le informamos que, durante la revisión de su toma de ramos, se detectó que inscribió una asignatura sin contar con sus requisitos. A continuación, se entrega el detalle del incumplimiento:',
    '',
    `• Carrera del alumno: ${c.carrera || '(sin información)'}`,
    `• Plan de estudios del alumno: ${planLabel}`,
    `• Asignatura inscrita: ${enrolledTitle} (${enrolledCode})`,
    `• NRC inscrito: ${enrolledNrc}`,
    `• Requisitos: ${ensureFinalPeriod_(reqMain)}`,
    '',
    `La revisión determinó que estos requisitos no se encuentran cumplidos, ya que ${why}.`,
    '',
    `Por lo anterior, la asignatura ${enrolledTitle} (${enrolledCode}) ha sido eliminada de su toma de ramos.`,
    '',
    `Le recordamos que, si lo estima necesario, cualquier solicitud de toma de ramos a estas alturas, debe ser presentada a través del canal alternativo (Banner, Comunicación Alumno Facultad, categoría "${general.categoriaSolicitudes}") a más tardar el ${general.fechaLimite}. Estas solicitudes se evaluarán de acuerdo a disponibilidad de cupos.`,
    '',
    'Saludos cordiales.'
  ].join('\n');
}

function ensureFinalPeriod_(value) {
  const s = asText_(value).trim();
  if (!s) return '';
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function buildNaturalMissingPrereqsExplanation_(detailRaw) {
  let detail = asText_(detailRaw).trim();
  if (!detail) return 'no fue posible acreditar el cumplimiento de los requisitos académicos exigidos';

  detail = detail.replace(
    /^Su plan sugiere\s+\S+\s+pero se inscribió en\s+\S+\.\s*Faltan requisitos para\s+\S+:\s*/i, ''
  );

  const planAlumnoMatch = detail.match(/Plan alumno:\s*([\s\S]*?)(?:\s*;\s*Plan alterno:|$)/i);
  if (planAlumnoMatch) detail = planAlumnoMatch[1].trim();

  const reasons = [];

  const sctMatch = detail.match(/SCT:\s*requiere\s*[≥>=]*\s*(\d+(?:[.,]\d+)?)\s*,\s*tiene\s*(\d+(?:[.,]\d+)?)/i);
  if (sctMatch) {
    reasons.push(`usted no cuenta con los ${sctMatch[1]} SCT aprobados exigidos (registra ${sctMatch[2]} SCT)`);
  }

  const coursePattern = /([^|;]+?)\s*\[([^\]]+)\]\s*→\s*([^|;]+)/g;
  let match;
  while ((match = coursePattern.exec(detail)) !== null) {
    let title = cleanTechnicalRequirementTitle_(match[1]);
    const codes = asText_(match[2]).trim();
    const reason = asText_(match[3]).trim().toUpperCase();
    if (!title) title = 'la asignatura requerida';

    if (reason.indexOf('NO INSCRITO CONCURRENTE') !== -1) {
      reasons.push(`usted no ha aprobado ni se encuentra inscrito/a concurrentemente en la asignatura ${title} [${codes}]`);
    } else if (reason.indexOf('DEBE') !== -1) {
      reasons.push(`usted no ha aprobado la asignatura ${title} [${codes}]`);
    } else if (reason.indexOf('NO MAPEADO') !== -1) {
      reasons.push(`no fue posible acreditar el requisito ${title}`);
    }
  }

  const unmappedPattern = /No mapeado:\s*"([^"]+)"/gi;
  while ((match = unmappedPattern.exec(detail)) !== null) {
    reasons.push(`no fue posible acreditar el requisito ${asText_(match[1]).trim()}`);
  }

  const uniqueReasons = unique_(reasons.map(x => x.trim()).filter(Boolean));

  if (uniqueReasons.length === 0) {
    const fallback = detail
      .replace(/^OR:\s*no cumple ninguna alternativa\s*→\s*/i, '')
      .replace(/\bAlt\d+:\s*/gi, '')
      .replace(/\s*\|\|\s*/g, '; ')
      .replace(/\s*\|\s*/g, '; ')
      .replace(/\s*→\s*/g, ': ')
      .replace(/\s+/g, ' ')
      .replace(/[.;:\s]+$/, '')
      .trim();
    return fallback
      ? `no fue posible acreditar lo siguiente: ${fallback}`
      : 'no fue posible acreditar el cumplimiento de los requisitos académicos exigidos';
  }

  const joined = joinSpanishList_(uniqueReasons);
  if (/^OR:\s*no cumple ninguna alternativa/i.test(detail)) {
    return `no cumple ninguna de las alternativas establecidas, dado que ${joined}`;
  }
  return joined;
}

function cleanTechnicalRequirementTitle_(value) {
  return asText_(value)
    .replace(/^OR:\s*no cumple ninguna alternativa\s*→\s*/i, '')
    .replace(/^Alt\d+:\s*/i, '')
    .replace(/^Plan alumno:\s*/i, '')
    .trim();
}

function joinSpanishList_(items) {
  const arr = unique_((items || []).map(x => asText_(x).trim()).filter(Boolean));
  if (arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  if (arr.length === 2) return `${arr[0]} y ${arr[1]}`;
  return `${arr.slice(0, -1).join(', ')} y ${arr[arr.length - 1]}`;
}

function buildCodigoIncorrectoCumpleMsg_(expectedCode, planId, enrolledCode, equivalenceNotes) {
  let msg = `Cumple requisitos para ${expectedCode} (su plan ${planId}), pero se inscribió en ${enrolledCode}.`;
  const notes = unique_((equivalenceNotes || []).map(x => asText_(x).trim()).filter(Boolean));
  if (notes.length) msg += ` Equivalencias utilizadas: ${notes.join(' | ')}`;
  return msg;
}

/* =========================
   NRC CORRECTO
========================= */
function findEquivalentNrc_(nrcIncorrecto, codigoEsperado, nrcIndex) {
  if (!nrcIncorrecto || !codigoEsperado) return { nrc: '', status: '', obs: 'Sin NRC o sin código esperado.' };
  if (!nrcIndex.periodOk) {
    return { nrc: '', status: 'SIN UG201 DEL PERIODO', obs: `Falta el listado de NRC (UG201) del período ${nrcIndex.period}.` };
  }

  const infoInc = nrcIndex.byNrc.get(nrcIncorrecto);
  if (!infoInc) return { nrc: '', status: 'NO ENCONTRADO', obs: `NRC no encontrado en el listado de NRC (UG201) del período ${nrcIndex.period}.` };

  const lcNorm = normalizeNrcKey_(infoInc.lc);
  if (!lcNorm) return { nrc: '', status: 'LC VACIO', obs: 'LC/LISTA CRUZADA vacío: no es posible identificar el NRC equivalente.' };

  const candidates = nrcIndex.byCodeLc.get(`${codigoEsperado}||${lcNorm}`) || [];
  if (!candidates.length) {
    return { nrc: '', status: 'NO ENCONTRADO', obs: `LC=${infoInc.lc} existe, pero no se encontró NRC para el código esperado ${codigoEsperado}.` };
  }

  const ranked = candidates
    .map(n => ({ nrc: n, score: scoreEquivalentNrc_(infoInc, nrcIndex.byNrc.get(n)) }))
    .sort((a, b) => b.score - a.score);

  return { nrc: cleanNrc_(ranked[0].nrc), status: '', obs: '' };
}

function nrcRow_(c, nrcInfo) {
  let obs = nrcInfo.obs ||
    `Alumno ${c.plan} inscrito en código de otro plan (inscrito ${c.codigo}, esperado ${c.codEsperado}).`;
  if (c.issue === 'CODIGO_PLAN_INCORRECTO_Y_FALTAN_REQUISITOS') {
    obs += ' Además, presenta requisitos faltantes para el código esperado.';
  }
  return [c.rut, c.titulo, c.nrc, nrcInfo.nrc || '', obs];
}

function buildNrcPorPeriodoIndex_(data, period) {
  if (!data || data.length < 2) throw new Error('El listado de NRC (UG201) no tiene datos.');

  const h = headerIndex_(data[0]);
  const cPer = findColOneOf_(h, ['PERIODO']);
  const cNrc = mustColOneOf_(h, ['NRC']);
  const cCod = mustColOneOf_(h, ['CODIGO']);
  const cLc = mustColOneOf_(h, ['LC', 'LISTA CRUZADA']);
  const cSecc = findColOneOf_(h, ['SECC.', 'SECC', 'SECCION', 'SECCIÓN']);
  const cTipo = findColOneOf_(h, ['TIPO', 'TIPO HORARIO', 'TIPO DE REUNION', 'TIPO DE REUNIÓN']);

  const byNrc = new Map();
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const nrc = cleanNrc_(row[cNrc]);
    const codigo = cleanCode_(row[cCod]);
    if (!nrc || !codigo) continue;
    if (period && cPer !== null && cleanCatalog_(row[cPer]) && cleanCatalog_(row[cPer]) !== period) continue;
    const lc = asText_(row[cLc]).trim();
    const secc = cSecc === null ? '' : asText_(row[cSecc]).trim();
    const tipo = cTipo === null ? '' : normalizeNrcKey_(row[cTipo]);

    let rec = byNrc.get(nrc);
    if (!rec) { rec = { nrc, codigo, lc, secc, tipos: new Set() }; byNrc.set(nrc, rec); }
    if (!rec.lc && lc) rec.lc = lc;
    if (!rec.secc && secc) rec.secc = secc;
    if (tipo) rec.tipos.add(tipo);
  }

  const byCodeLc = new Map();
  for (const rec of byNrc.values()) {
    const lcNorm = normalizeNrcKey_(rec.lc);
    if (!lcNorm) continue;
    const key = `${rec.codigo}||${lcNorm}`;
    let arr = byCodeLc.get(key);
    if (!arr) { arr = []; byCodeLc.set(key, arr); }
    if (!arr.includes(rec.nrc)) arr.push(rec.nrc);
  }
  return { byNrc, byCodeLc, periodOk: byNrc.size > 0, period };
}

function scoreEquivalentNrc_(actual, cand) {
  if (!cand) return -1;
  let score = 0;
  const a = normalizeNrcKey_(actual && actual.secc);
  const b = normalizeNrcKey_(cand.secc);
  if (a && b && a === b) score += 1000;

  const at = (actual && actual.tipos) || new Set();
  const ct = cand.tipos || new Set();
  let overlap = 0;
  for (const t of at) if (ct.has(t)) overlap++;
  score += overlap * 20;
  if (at.size > 0 && at.size === ct.size && overlap === at.size) score += 5;
  return score;
}

function normalizeNrcKey_(v) {
  return asText_(v).trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/* =========================
   ELECTIVOS
========================= */
function buildElectivosIndex_(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) throw new Error(`No hay datos en "${sheet.getName()}"`);

  const h = headerIndex_(data[0]);
  const cCod = mustCol_(h, 'CODIGO');
  const cTit = mustCol_(h, 'TITULO');
  const cPe = mustColOneOf_(h, ['PE']);
  const cEsp = mustColOneOf_(h, ['ESPECIALIDAD']);

  const byCode = new Map();
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const code = cleanCode_(row[cCod]);
    if (!code) continue;
    const title = asText_(row[cTit]).trim();
    const pe = parsePeTokens_(row[cPe]);
    const esp = parseListSet_(row[cEsp]);

    const prev = byCode.get(code);
    if (!prev) byCode.set(code, { title, pe, especialidades: esp });
    else {
      prev.title = prev.title || title;
      for (const x of pe) prev.pe.add(x);
      for (const x of esp) prev.especialidades.add(x);
    }
  }
  return { byCode };
}

/**
 * PE puede ser BOTH, una familia (OLD, PE2026, PE2027...), un PLAN_ID o un
 * período de catálogo (202610, 202710...). Los períodos se traducen a familia
 * con las reglas globales "*" de CONFIG_PLANES (ver electivePeAllows_).
 */
function parsePeTokens_(v) {
  const out = new Set();
  for (const raw of splitList_(asText_(v))) {
    const s = raw.trim().toUpperCase();
    if (!s) continue;
    if (s === 'AMBOS' || s === 'TODOS') out.add('BOTH');
    else out.add(s);
  }
  return out;
}

/** Familia de un período de catálogo según las reglas globales; si ninguna aplica, OLD. */
function familyForCatalog_(plans, catalog) {
  const p = resolvePlan_(plans, '', catalog);
  return p && p.familia ? p.familia : 'OLD';
}

function electivePeAllows_(peSet, plan, plans) {
  if (!peSet || peSet.size === 0 || peSet.has('BOTH')) return true;

  const tokens = new Set();
  for (const t of peSet) tokens.add(/^\d{6}$/.test(t) ? familyForCatalog_(plans, t) : t);

  const known = new Set(['OLD']);
  for (const p of plans) { known.add(p.id.toUpperCase()); if (p.familia) known.add(p.familia); }

  let anyKnown = false;
  for (const t of tokens) if (known.has(t)) anyKnown = true;
  if (!anyKnown) return true;   // valor no reconocido: no se rechaza

  return tokens.has(plan.id.toUpperCase()) || (plan.familia && tokens.has(plan.familia));
}

function electiveEspecialidadAllows_(espSet, carrera) {
  if (!espSet || espSet.size === 0) return true;
  const c = asText_(carrera).trim().toUpperCase();
  return !!c && espSet.has(c);
}

function buildElectivoNoPermitidoMsg_(code, elec, peOk, espOk, plan, carrera) {
  const esp = elec.especialidades.size ? Array.from(elec.especialidades).join(',') : '(TODAS)';
  const reasons = [];
  if (!peOk) reasons.push(`PE=${Array.from(elec.pe).join(',')} no permite el plan ${plan.id}`);
  if (!espOk) reasons.push(`ESPECIALIDAD=${esp} no incluye CARRERA=${carrera || '(VACIO)'}`);
  return `Electivo ${code} encontrado en ELECTIVOS, pero NO permitido: ${reasons.join(' ; ')}`;
}

/* =========================
   REQUISITOS: PARSER Y EVALUACIÓN
========================= */
function parseRequisitos_(reqRaw) {
  const s0 = asText_(reqRaw).trim();
  if (!s0) return { sctRequired: null, groups: [] };

  const re = /(\d+)\s*SCT/ig;
  let m;
  let sctMax = null;
  while ((m = re.exec(s0)) !== null) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n)) sctMax = sctMax === null ? n : Math.max(sctMax, n);
  }

  const groups = [];
  for (let part of splitTopLevelOr_(s0)) {
    part = trimOuterParens_(part.trim());
    const group = [];
    for (let it of splitTopLevel_(part, ',')) {
      it = asText_(it).trim();
      if (!it) continue;
      if (/\bSCT\b/i.test(it) && /\d/.test(it)) continue;
      const concurrent = /\(p\)/i.test(it);
      it = it.replace(/\(p\)/ig, ' ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!it) continue;
      group.push({ title: it, concurrent });
    }
    if (group.length) groups.push(mergeCommaTitles_(group));
  }
  return { sctRequired: sctMax, groups };
}

/**
 * Une ítems separados por coma que en realidad forman un solo título de
 * catálogo (ej.: "Ecología, Medio Ambiente y Energía").
 */
function mergeCommaTitles_(group) {
  const titles = getAllCatalogTitleNorms_();
  if (!titles || !titles.size) return group;

  const out = [];
  for (let i = 0; i < group.length; i++) {
    let merged = null;
    for (let j = group.length - 1; j > i; j--) {
      const candidate = group.slice(i, j + 1).map(x => x.title).join(', ');
      if (titles.has(normalizeTitle_(candidate))) {
        merged = { title: candidate, concurrent: group.slice(i, j + 1).some(x => x.concurrent), span: j };
        break;
      }
    }
    if (merged) { out.push({ title: merged.title, concurrent: merged.concurrent }); i = merged.span; }
    else out.push(group[i]);
  }
  return out;
}

let ALL_TITLE_NORMS_ = null;
function getAllCatalogTitleNorms_() { return ALL_TITLE_NORMS_; }

const PARSE_CACHE_ = new Map();
function parseRequisitosCached_(reqRaw) {
  const k = asText_(reqRaw);
  if (!PARSE_CACHE_.has(k)) PARSE_CACHE_.set(k, parseRequisitos_(k));
  return PARSE_CACHE_.get(k);
}

function evaluatePrereqs_(args) {
  const { courseCode, reqRaw, student, mainCatalog, fallbackCatalogs, courseEquivalence } = args;
  const parsed = parseRequisitosCached_(reqRaw);

  const issues = [];
  const missingByAlt = [];
  const equivalenceNotes = [];
  const extraSources = [];

  if (parsed.sctRequired !== null && (student.sct + 1e-9) < parsed.sctRequired) {
    issues.push(`SCT: requiere ≥ ${parsed.sctRequired}, tiene ${Math.floor(student.sct)}`);
  }

  if (parsed.groups.length) {
    let anyGroupOk = false;
    const altDetails = [];
    const groupExtra = [];

    for (let g = 0; g < parsed.groups.length; g++) {
      const missTexts = [];
      const missItems = [];
      const extraHere = [];
      const notesHere = [];

      for (const reqItem of parsed.groups[g]) {
        const expanded = expandRequirementItem_(reqItem.title, courseCode, mainCatalog, fallbackCatalogs, courseEquivalence);

        for (const ex of expanded) {
          if (!ex.codes.length) {
            missTexts.push(`No mapeado: "${ex.title}"`);
            missItems.push({ title: ex.title, codes: [], isConcurrent: !!reqItem.concurrent, reason: 'NO MAPEADO' });
            continue;
          }

          const met = isAnyCodeSatisfied_(
            ex.baseCodes.length ? ex.baseCodes : ex.codes,
            student, reqItem.concurrent, courseEquivalence
          );

          if (!met.ok) {
            missTexts.push(`${ex.title} [${met.checkedCodes.join('/')}] → ${met.reason}`);
            missItems.push({ title: ex.title, codes: met.checkedCodes, isConcurrent: !!reqItem.concurrent, reason: met.reason });
          } else {
            if (met.matchedBy.indexOf('EQUIVALENTE') !== -1 || met.source) {
              notesHere.push(
                `${ex.title}: requisito ${ex.baseCodes.join('/') || ex.codes[0]} cumplido con ${met.matchedCode}` +
                ` (${met.source ? met.source : met.matchedBy}).`
              );
            }
            if (met.source) extraHere.push(`${ex.title} → ${met.matchedCode} aprobado en ${met.source}`);
          }
        }
      }

      missingByAlt.push({ altIndex: g + 1, missingItems: missItems });

      if (!missTexts.length) {
        anyGroupOk = true;
        equivalenceNotes.push(...notesHere);
        groupExtra.push(...extraHere);
        break;
      }
      equivalenceNotes.push(...notesHere);
      altDetails.push(`Alt${g + 1}: ${missTexts.join(' | ')}`);
    }

    if (!anyGroupOk) {
      issues.push(parsed.groups.length === 1
        ? altDetails[0].replace(/^Alt1:\s*/, '')
        : `OR: no cumple ninguna alternativa → ${altDetails.join(' || ')}`);
    } else {
      extraSources.push(...groupExtra);
    }
  }

  return {
    cumple: issues.length === 0,
    detalle: issues.join(' ; '),
    missingByAlt,
    equivalenceNotes: unique_(equivalenceNotes),
    extraSources: unique_(extraSources)
  };
}

function isAnyCodeSatisfied_(codes, student, concurrent, courseEquivalence) {
  const baseCodes = unique_((codes || []).map(cleanCode_).filter(Boolean));
  const checkedCodes = expandEquivalentCodes_(baseCodes, courseEquivalence);
  const baseSet = new Set(baseCodes);

  // 1) Aprobado en CUMPLIMIENTO MALLA (directo o equivalente)
  for (const c of checkedCodes) {
    if ((student.status.get(c) || '') === 'APROBADO') {
      return { ok: true, reason: '', matchedCode: c, matchedBy: baseSet.has(c) ? 'APROBADO_DIRECTO' : 'APROBADO_EQUIVALENTE', source: '', checkedCodes };
    }
  }
  // 2) Concurrente inscrito
  if (concurrent) {
    for (const c of checkedCodes) {
      if (student.enrolled.has(c)) {
        return { ok: true, reason: '', matchedCode: c, matchedBy: baseSet.has(c) ? 'CONCURRENTE_DIRECTO' : 'CONCURRENTE_EQUIVALENTE', source: '', checkedCodes };
      }
    }
  }
  // 3) Aprobado en CAPP ADICIONAL / CODIGO ALTERNATIVO (antes "Paso 2")
  for (const c of checkedCodes) {
    if (student.extra.has(c)) {
      return { ok: true, reason: '', matchedCode: c, matchedBy: baseSet.has(c) ? 'APROBADO_DIRECTO' : 'APROBADO_EQUIVALENTE', source: student.extra.get(c), checkedCodes };
    }
  }

  return {
    ok: false,
    reason: concurrent ? 'DEBE y no inscrito concurrente (ni código equivalente)' : 'DEBE (sin código equivalente aprobado)',
    checkedCodes
  };
}

function expandRequirementItem_(title, parentCode, mainCatalog, fallbackCatalogs, courseEquivalence) {
  const t = asText_(title).trim();
  if (!t) return [{ title: t, codes: [], baseCodes: [] }];

  const whole = resolveCodesByTitleWithScore_(t, parentCode, mainCatalog, fallbackCatalogs);
  if (whole.codes.length) {
    const baseCodes = unique_(whole.codes.map(cleanCode_).filter(Boolean));
    return [{ title: t, baseCodes, codes: expandEquivalentCodes_(baseCodes, courseEquivalence) }];
  }

  if (/\sY\s/.test(normalizeTitle_(t))) {
    const parts = t.split(/\s+y\s+/i).map(x => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const expanded = [];
      for (const p of parts) {
        const res = resolveCodesByTitleWithScore_(p, parentCode, mainCatalog, fallbackCatalogs);
        if (!res.codes.length || res.score < 0.78) return [{ title: t, codes: [], baseCodes: [] }];
        const baseCodes = unique_(res.codes.map(cleanCode_).filter(Boolean));
        expanded.push({ title: p, baseCodes, codes: expandEquivalentCodes_(baseCodes, courseEquivalence) });
      }
      return expanded;
    }
  }
  return [{ title: t, codes: [], baseCodes: [] }];
}

const RESOLVE_CACHE_ = new Map();
function resolveCodesByTitleWithScore_(title, parentCode, mainCatalog, fallbackCatalogs) {
  const tNorm = normalizeTitle_(title);
  if (!tNorm) return { codes: [], score: 0 };

  const key = [tNorm, cleanCode_(parentCode).slice(0, 3), mainCatalog.name]
    .concat(fallbackCatalogs.map(c => c.name)).join('§');
  if (RESOLVE_CACHE_.has(key)) return RESOLVE_CACHE_.get(key);

  let result = null;
  for (const cat of [mainCatalog].concat(fallbackCatalogs)) {
    const exact = cat.titleToCodes.get(tNorm);
    if (exact) { result = { codes: normalizeCodesPick_(exact, parentCode), score: 1 }; break; }
    const best = bestTitleKeyWithScore_(tNorm, cat);
    if (best.key && best.score >= 0.72) {
      result = { codes: normalizeCodesPick_(cat.titleToCodes.get(best.key), parentCode), score: best.score };
      break;
    }
  }
  if (!result) {
    let s = 0;
    for (const cat of [mainCatalog].concat(fallbackCatalogs)) s = Math.max(s, bestTitleKeyWithScore_(tNorm, cat).score);
    result = { codes: [], score: s };
  }
  RESOLVE_CACHE_.set(key, result);
  return result;
}

function normalizeCodesPick_(codes, parentCode) {
  const arr = (Array.isArray(codes) ? codes : [codes]).map(cleanCode_);
  if (arr.length <= 1) return arr;
  const pref = cleanCode_(parentCode).slice(0, 3);
  if (pref) {
    const filtered = arr.filter(c => c.startsWith(pref));
    if (filtered.length) return filtered;
  }
  return [arr[0]];
}

/* =========================
   CUMPLIMIENTO / CAPP
========================= */
function buildCumplimientoIndex_(data) {
  if (!data || data.length < 2) throw new Error('El cumplimiento de malla (RA311) no tiene datos.');

  const h = headerIndex_(data[0]);
  const cRut = mustCol_(h, 'RUT');
  const cCod = mustCol_(h, 'CODIGO');
  const cEst = mustCol_(h, 'ESTADO CURSO');
  const cCred = mustColOneOf_(h, ['CREDITOS', 'CRÉDITOS', 'CREDITO', 'CRÉDITO']);
  const cCarr = findColOneOf_(h, ['CARRERA', 'CARRERA BANNER 2026', 'CARRERA BANNER', 'CARRERA_BANNER', 'CARRERA_BANNER_2026']);
  const cPer = findColOneOf_(h, ['PERIODO CURSADO']);
  const cNrc = findColOneOf_(h, ['NRC']);
  const cTitAlt = findColOneOf_(h, ['TITULO ALTERNATIVO']);
  const cAlt = findColOneOf_(h, ['CODIGO ALTERNATIVO', 'CÓDIGO ALTERNATIVO', 'CODIGO_ALTERNATIVO']);

  const statusByRut = new Map();
  const carreraByRut = new Map();
  const sctRawByRut = new Map();
  const sctUnitsByRut = new Map();   // rut -> Map(llaveCurso -> créditos)
  const altApprovedByRut = new Map();

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rut = cleanRut_(row[cRut]);
    const code = cleanCode_(row[cCod]);
    if (!rut || !code) continue;

    const estado = asText_(row[cEst]).trim().toUpperCase();

    let m = statusByRut.get(rut);
    if (!m) { m = new Map(); statusByRut.set(rut, m); }
    if (m.get(code) !== 'APROBADO') m.set(code, estado);

    if (cCarr !== null && !carreraByRut.has(rut)) {
      const carr = asText_(row[cCarr]).trim();
      if (carr) carreraByRut.set(rut, carr);
    }

    if (estado !== 'APROBADO') continue;

    const cred = toNumberStrict_(row[cCred]);
    const add = isNaN(cred) ? 0 : cred;
    sctRawByRut.set(rut, (sctRawByRut.get(rut) || 0) + add);

    // SCT: un curso cursado se cuenta una sola vez aunque cubra varias reglas
    const per = cPer === null ? '' : cleanCatalog_(row[cPer]);
    const nrc = cNrc === null ? '' : cleanNrc_(row[cNrc]);
    const titAlt = cTitAlt === null ? '' : normalizeTitle_(row[cTitAlt]);
    const unitKey = nrc
      ? `P${per}|N${nrc}`
      : (titAlt ? `P${per}|T${titAlt}` : `P${per}|C${code}|R${i}`);

    let u = sctUnitsByRut.get(rut);
    if (!u) { u = new Map(); sctUnitsByRut.set(rut, u); }
    u.set(unitKey, Math.max(u.get(unitKey) || 0, add));

    if (cAlt !== null) {
      const parts = asText_(row[cAlt]).split(/[,;|/]+/).map(cleanCode_).filter(Boolean);
      if (parts.length) {
        let s = altApprovedByRut.get(rut);
        if (!s) { s = new Set(); altApprovedByRut.set(rut, s); }
        for (const p of parts) s.add(p);
      }
    }
  }

  const sctByRut = new Map();
  for (const [rut, units] of sctUnitsByRut.entries()) {
    let s = 0;
    for (const v of units.values()) s += v;
    sctByRut.set(rut, s);
  }

  return { statusByRut, carreraByRut, sctByRut, sctRawByRut, altApprovedByRut };
}

function buildCappApprovedIndex_(data) {
  const out = new Map();
  if (!data || data.length < 2) return out;

  const h = headerIndex_(data[0]);
  const cRut = mustCol_(h, 'RUT');
  const cCod = mustCol_(h, 'CODIGO');
  const cEst = mustCol_(h, 'ESTADO CURSO');

  for (let i = 1; i < data.length; i++) {
    const rut = cleanRut_(data[i][cRut]);
    const code = cleanCode_(data[i][cCod]);
    if (!rut || !code) continue;
    if (asText_(data[i][cEst]).trim().toUpperCase() !== 'APROBADO') continue;
    let m = out.get(rut);
    if (!m) { m = new Map(); out.set(rut, m); }
    m.set(code, 'CAPP ADICIONAL');
  }
  return out;
}

/* =========================
   CATÁLOGOS
========================= */
function buildCatalogIndex_(sheet, name) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) throw new Error(`No hay datos en "${sheet.getName()}"`);

  const h = headerIndex_(data[0]);
  const cCode = mustCol_(h, 'CODIGO');
  const cTit = mustCol_(h, 'TITULO');
  const cReq = mustCol_(h, 'Requisitos');
  const cConc = findColOneOf_(h, ['CONCENTRACION', 'CONCENTRACIÓN']);

  const majorCols = [];
  for (let j = 0; j < data[0].length; j++) {
    const t = normalizeHeaderToken_(data[0][j]);
    if (MAJOR_COLUMNS.includes(t)) majorCols.push({ major: t, col: j });
  }

  const codeToReq = new Map();
  const codeToTitle = new Map();
  const titleToCodes = new Map();
  const codeToMajorFlags = new Map();
  const codeToConcentracion = new Map();

  for (let i = 1; i < data.length; i++) {
    const code = cleanCode_(data[i][cCode]);
    if (!code) continue;

    const title = asText_(data[i][cTit]).trim();
    const titleNorm = normalizeTitle_(title);
    codeToReq.set(code, asText_(data[i][cReq]));
    codeToTitle.set(code, title);

    if (titleNorm) {
      const arr = titleToCodes.get(titleNorm) || [];
      arr.push(code);
      titleToCodes.set(titleNorm, arr);
      if (!ALL_TITLE_NORMS_) ALL_TITLE_NORMS_ = new Set();
      ALL_TITLE_NORMS_.add(titleNorm);
    }

    const flags = new Map();
    for (const mc of majorCols) flags.set(mc.major, !!asText_(data[i][mc.col]).trim());
    codeToMajorFlags.set(code, flags);
    codeToConcentracion.set(code, cConc === null ? '' : asText_(data[i][cConc]).trim());
  }

  const stop = stopwordsSet_();
  const keysMeta = [];
  for (const key of titleToCodes.keys()) {
    keysMeta.push({
      key,
      tokens: new Set(key.split(' ').filter(t => t && !stop.has(t))),
      compact: key.replace(/\s+/g, '')
    });
  }

  return {
    name: name || sheet.getName(),
    codeToReq, codeToTitle, titleToCodes, keysMeta,
    codeToMajorFlags, codeToConcentracion,
    bestCache: new Map()
  };
}

/**
 * Equivalencia académica: códigos con el mismo título normalizado en
 * cualquier catálogo cargado + pares explícitos de la hoja EQUIVALENCIAS.
 * NO determina si el código inscrito es el correcto para el plan.
 */
function buildCourseEquivalenceIndex_(catalogIndexes, explicitPairs) {
  const codeToEquivalentCodes = new Map();
  const addAll = (codes) => {
    for (const c of codes) {
      let s = codeToEquivalentCodes.get(c);
      if (!s) { s = new Set(); codeToEquivalentCodes.set(c, s); }
      for (const d of codes) s.add(d);
    }
  };

  const byTitle = new Map();
  for (const cat of catalogIndexes) {
    for (const [titleNorm, codes] of cat.titleToCodes.entries()) {
      let s = byTitle.get(titleNorm);
      if (!s) { s = new Set(); byTitle.set(titleNorm, s); }
      for (const c of codes) s.add(cleanCode_(c));
    }
  }
  for (const s of byTitle.values()) addAll(Array.from(s));
  for (const [a, b] of (explicitPairs || [])) addAll([a, b]);

  return { codeToEquivalentCodes };
}

function expandEquivalentCodes_(codes, courseEquivalence) {
  const out = [];
  const seen = new Set();
  for (const raw of codes || []) {
    const code = cleanCode_(raw);
    if (!code) continue;
    if (!seen.has(code)) { seen.add(code); out.push(code); }
    const eq = courseEquivalence.codeToEquivalentCodes.get(code);
    if (eq) for (const e of eq) if (!seen.has(e)) { seen.add(e); out.push(e); }
  }
  return out;
}

function bestTitleKeyWithScore_(titleNorm, catalog) {
  if (catalog.bestCache.has(titleNorm)) return catalog.bestCache.get(titleNorm);

  const stop = stopwordsSet_();
  const tSet = new Set(titleNorm.split(' ').filter(t => t && !stop.has(t)));
  const tCompact = titleNorm.replace(/\s+/g, '');

  let bestKey = null;
  let bestScore = 0;
  for (const meta of catalog.keysMeta) {
    let inter = 0;
    for (const t of tSet) if (meta.tokens.has(t)) inter++;
    const tokScore = inter / Math.max(1, tSet.size);
    const bonus = meta.key.indexOf(titleNorm) !== -1 ? 0.25 : 0;
    const score = Math.max(tokScore + bonus, levenshteinSimilarity_(tCompact, meta.compact));
    if (score > bestScore) { bestScore = score; bestKey = meta.key; }
  }
  const res = { key: bestKey, score: bestScore };
  catalog.bestCache.set(titleNorm, res);
  return res;
}

function resolveAnyCodesByTitle_Multi_(title, catalogs) {
  const out = new Set();
  const tNorm = normalizeTitle_(title);
  if (!tNorm) return [];
  for (const cat of catalogs) for (const c of (cat.titleToCodes.get(tNorm) || [])) out.add(cleanCode_(c));
  if (!out.size) {
    for (const cat of catalogs) {
      const best = bestTitleKeyWithScore_(tNorm, cat);
      if (best.key && best.score >= 0.72) for (const c of cat.titleToCodes.get(best.key) || []) out.add(cleanCode_(c));
    }
  }
  return Array.from(out);
}

function getAltPlanRequisitos_(enrolledCode, enrolledTitle, altCatalog) {
  const code = cleanCode_(enrolledCode);
  let reqRaw = asText_(altCatalog.codeToReq.get(code)).trim();
  if (reqRaw) return { reqRaw, altCodeForDisplay: code };

  const tNorm = normalizeTitle_(enrolledTitle);
  if (!tNorm) return { reqRaw: '', altCodeForDisplay: '' };

  let codes = altCatalog.titleToCodes.get(tNorm) || null;
  if (!codes) {
    const best = bestTitleKeyWithScore_(tNorm, altCatalog);
    if (best.key && best.score >= 0.72) codes = altCatalog.titleToCodes.get(best.key) || null;
  }
  if (!codes) return { reqRaw: '', altCodeForDisplay: '' };

  const altCode = cleanCode_(codes[0]);
  return { reqRaw: asText_(altCatalog.codeToReq.get(altCode)).trim(), altCodeForDisplay: altCode };
}

function findEquivalentCandidatesInPlanByTitle_(title, catalog) {
  const tNorm = normalizeTitle_(title);
  if (!tNorm) return [];
  let codes = catalog.titleToCodes.get(tNorm) || null;
  if (!codes || !codes.length) {
    const best = bestTitleKeyWithScore_(tNorm, catalog);
    if (best.key && best.score >= 0.80) codes = catalog.titleToCodes.get(best.key) || null;
  }
  if (!codes || !codes.length) return [];
  return unique_(codes.map(cleanCode_).filter(Boolean));
}

/* =========================
   LISTA FLEXIBLE
========================= */
function buildFlexIndex_(titles, catalogs) {
  const titleNormSet = new Set();
  const codeSet = new Set();
  for (const t of titles) {
    const tn = normalizeTitle_(t);
    if (tn) titleNormSet.add(tn);
    for (const c of resolveAnyCodesByTitle_Multi_(t, catalogs)) codeSet.add(c);
  }
  return { titleNormSet, codeSet };
}

function isFlexibleCourse_(code, title, flex) {
  if (flex.codeSet.has(cleanCode_(code))) return true;
  const tn = normalizeTitle_(title);
  return tn ? flex.titleNormSet.has(tn) : false;
}

/* =========================
   PLAN / MAJOR
========================= */
function courseAllowedForCarrera_(catalog, code, carrera, plan) {
  const c = cleanCode_(code);
  const car = asText_(carrera).trim().toUpperCase();
  const major = CARRERA_TO_MAJOR[car] || car;

  if (!c) return { allowed: false, reason: 'Código vacío.' };
  if (!major) return { allowed: false, reason: `No fue posible determinar la major del alumno a partir de CARRERA="${carrera}".` };
  if (!catalog.codeToReq.has(c)) return { allowed: false, reason: `Código ${c} no existe en el catálogo del plan ${plan.id}.` };

  const flags = catalog.codeToMajorFlags.get(c);
  if (!flags || flags.size === 0 || !flags.has(major)) return { allowed: true, reason: '' };
  if (flags.get(major)) return { allowed: true, reason: '' };

  if (plan.permiteCt && asText_(catalog.codeToConcentracion.get(c)).trim()) {
    return { allowed: true, reason: '' };
  }

  return {
    allowed: false,
    reason: `Curso ${c} no pertenece al plan de la carrera ${carrera} ` +
      `(columna ${major} vacía en ${catalog.name}${plan.permiteCt ? ' y sin Concentración/CT' : ''}).`
  };
}

/* =========================
   AUXILIARES DE EVALUACIÓN
========================= */
function extractMissingCodes_(missingByAlt) {
  const out = new Set();
  for (const alt of missingByAlt || []) {
    for (const miss of alt.missingItems || []) {
      if (miss.codes && miss.codes.length) for (const c of miss.codes) out.add(cleanCode_(c));
      else if (miss.title) out.add(`"${miss.title}" (no mapeado)`);
    }
  }
  return Array.from(out).filter(Boolean);
}

function buildVeranoInfo_(missingByAlt, summerSet) {
  if (!missingByAlt || !missingByAlt.length || !summerSet || !summerSet.size) return '';
  const notes = [];
  const seen = new Set();
  for (const alt of missingByAlt) {
    for (const miss of alt.missingItems) {
      if (!miss.codes || !miss.codes.length) continue;
      if (!miss.codes.some(c => summerSet.has(cleanCode_(c)))) continue;
      const key = normalizeTitle_(miss.title || '') + '|' + (miss.isConcurrent ? 'P' : 'N');
      if (seen.has(key)) continue;
      seen.add(key);
      notes.push(`Cursando ${miss.title} Semestre Verano${miss.isConcurrent ? ' (requisito concurrente)' : ''}`);
    }
  }
  return notes.join(' | ');
}

function combineInfo_(a, b, label) {
  a = (a || '').trim();
  b = (b || '').trim();
  if (!a && !b) return '';
  if (a && !b) return a;
  if (!a && b) return `${label}: ${b}`;
  return `${a} ; ${label}: ${b}`;
}

/* =========================
   SEGUIMIENTO DIARIO
========================= */
function applyTracking_(ss, ctx, result) {
  const today = ctx.todayKey;

  /* 1) Valores manuales actuales en ALUMNOS_SIN_REQUISITOS */
  const generated = new Set(MAIN_HEADERS_GENERATED.concat(LEGACY_GENERATED_HEADERS, ['RUT']).map(x => x.toUpperCase()));
  const manualCols = MANUAL_COLS_DEFAULT.slice();
  const manualFromSheet = new Map();

  const shMain = ss.getSheetByName(SH.OUT_MAIN);
  if (shMain && shMain.getLastRow() >= 1) {
    const data = shMain.getDataRange().getValues();
    const hdr = data[0].map(x => asText_(x).trim());
    for (const name of hdr) {
      if (name && !generated.has(name.toUpperCase()) && !manualCols.some(m => m.toUpperCase() === name.toUpperCase())) {
        manualCols.push(name);
      }
    }
    const h = headerIndex_(hdr);
    const cId = findColOneOf_(h, ['CASO_ID']);
    const cRut = findColOneOf_(h, ['RUT']);
    const cNrc = findColOneOf_(h, ['NRC']);
    const cCod = findColOneOf_(h, ['CODIGO INSCRITO']);

    for (let i = 1; i < data.length; i++) {
      const r = data[i];
      let id = cId !== null ? asText_(r[cId]).trim() : '';
      if (!id && cRut !== null && cNrc !== null && cCod !== null) id = caseId_(r[cRut], r[cNrc], r[cCod]);
      if (!id || id === '||') continue;
      const vals = {};
      for (const m of manualCols) {
        const ci = findColOneOf_(h, [m]);
        vals[m] = ci === null ? '' : r[ci];
      }
      manualFromSheet.set(id, vals);
    }
  }

  /* 2) Historial previo */
  const hist = new Map();
  const shHist = ss.getSheetByName(SH.HISTORIAL);
  if (shHist && shHist.getLastRow() >= 2) {
    const data = shHist.getDataRange().getValues();
    const hdr = data[0].map(x => asText_(x).trim());
    const fixed = new Set(HIST_HEADERS_FIXED.map(x => x.toUpperCase()));
    for (const name of hdr) {
      if (name && !fixed.has(name.toUpperCase()) && !manualCols.some(m => m.toUpperCase() === name.toUpperCase())) {
        manualCols.push(name);
      }
    }
    for (let i = 1; i < data.length; i++) {
      const rec = {};
      hdr.forEach((name, j) => { if (name) rec[name] = data[i][j]; });
      const id = asText_(rec.CASO_ID).trim();
      if (!id) continue;
      for (const k of ['PRIMERA_DETECCION', 'ULTIMA_DETECCION', 'FECHA_RESOLUCION', 'FECHA_REAPERTURA']) {
        rec[k] = toDateKey_(rec[k]);
      }
      hist.set(id, rec);
    }
  }

  /* 3) Las ediciones manuales en la hoja principal prevalecen */
  for (const [id, vals] of manualFromSheet.entries()) {
    const rec = hist.get(id);
    if (rec) Object.assign(rec, vals);
  }

  /* 4) Casos detectados hoy */
  const current = new Set();
  const perCase = new Map();
  let newToday = 0;
  let reopenedToday = 0;

  for (const c of result.cases) {
    current.add(c.id);
    let rec = hist.get(c.id);
    let seguimiento;

    if (!rec) {
      rec = { CASO_ID: c.id, ESTADO_CASO: 'ABIERTO', PRIMERA_DETECCION: today, CAMBIOS_ISSUE: '' };
      Object.assign(rec, manualFromSheet.get(c.id) || {});
      hist.set(c.id, rec);
    } else if (asText_(rec.ESTADO_CASO).toUpperCase() === 'RESUELTO') {
      rec.ESTADO_CASO = 'ABIERTO';
      rec.FECHA_REAPERTURA = today;
      rec.FECHA_RESOLUCION = '';
      rec.MOTIVO_RESOLUCION = '';
    }

    const prevIssue = asText_(rec.ISSUE_TYPE).trim();
    if (prevIssue && prevIssue !== c.issue) {
      rec.CAMBIOS_ISSUE = [asText_(rec.CAMBIOS_ISSUE).trim(), `${today}: ${prevIssue} → ${c.issue}`].filter(Boolean).join(' | ');
    }

    Object.assign(rec, {
      RUT: c.rut, CARRERA: c.carrera, 'PLAN DEL ALUMNO': c.plan, NRC: c.nrc,
      'CODIGO INSCRITO': c.codigo, 'TITULO INSCRITO': c.titulo, ISSUE_TYPE: c.issue,
      'NRC CORRECTO': c.nrcCorrecto, CODIGO_ESPERADO_PLAN: c.codEsperado,
      ULTIMA_DETECCION: today
    });

    if (rec.PRIMERA_DETECCION === today) { seguimiento = 'NUEVO'; newToday++; }
    else if (rec.FECHA_REAPERTURA === today) { seguimiento = 'REABIERTO'; reopenedToday++; }
    else {
      const d = daysBetween_(rec.PRIMERA_DETECCION, today);
      seguimiento = `PERSISTE (${d} ${d === 1 ? 'día' : 'días'})`;
    }

    const manual = {};
    for (const m of manualCols) manual[m] = rec[m] === undefined ? '' : rec[m];
    perCase.set(c.id, { seguimiento, primera: rec.PRIMERA_DETECCION, manual });
  }

  /* 5) Casos que ya no aparecen -> RESUELTO */
  for (const rec of hist.values()) {
    if (current.has(rec.CASO_ID)) continue;
    if (asText_(rec.ESTADO_CASO).toUpperCase() === 'RESUELTO') continue;
    rec.ESTADO_CASO = 'RESUELTO';
    rec.FECHA_RESOLUCION = today;
    rec.MOTIVO_RESOLUCION = resolutionReason_(rec, ctx);
  }

  const resolvedTodayRecs = Array.from(hist.values())
    .filter(r => asText_(r.ESTADO_CASO).toUpperCase() === 'RESUELTO' && r.FECHA_RESOLUCION === today);
  const newTodayRecs = Array.from(hist.values())
    .filter(r => current.has(r.CASO_ID) && (r.PRIMERA_DETECCION === today || r.FECHA_REAPERTURA === today));

  /* 6) Escribir historial */
  const histHeader = HIST_HEADERS_FIXED.concat(manualCols);
  const histRows = Array.from(hist.values())
    .sort((a, b) => {
      const ea = asText_(a.ESTADO_CASO) === 'ABIERTO' ? 0 : 1;
      const eb = asText_(b.ESTADO_CASO) === 'ABIERTO' ? 0 : 1;
      if (ea !== eb) return ea - eb;
      return asText_(a.CASO_ID).localeCompare(asText_(b.CASO_ID));
    })
    .map(r => histHeader.map(k => (r[k] === undefined || r[k] === null) ? '' : r[k]));
  writeTable_(ss, SH.HISTORIAL, histHeader, histRows);

  /* 7) Comparación de inscripciones contra el último día anterior */
  const snap = compareSnapshots_(ss, ctx);

  return {
    manualCols, perCase, newToday, reopenedToday,
    resolvedToday: resolvedTodayRecs.length,
    resolvedTodayRecs, newTodayRecs, snap
  };
}

function resolutionReason_(rec, ctx) {
  const rut = cleanRut_(rec.RUT);
  const nrc = cleanNrc_(rec.NRC);
  const nrcs = ctx.ramos.nrcsByRut.get(rut) || new Set();
  const codes = ctx.ramos.codesByRut.get(rut) || new Set();

  if (nrc && nrcs.has(nrc)) {
    return 'Sigue inscrito en el NRC, pero ya no presenta incumplimiento (cumple requisitos o cambió la información base/configuración).';
  }
  const nrcOk = cleanNrc_(rec['NRC CORRECTO']);
  if (nrcOk && /^\d+$/.test(nrcOk) && nrcs.has(nrcOk)) return `Se cambió al NRC correcto ${nrcOk}.`;
  const codOk = cleanCode_(rec.CODIGO_ESPERADO_PLAN);
  if (codOk && codes.has(codOk)) return `Se inscribió en el código correcto ${codOk}.`;
  return 'Inscripción eliminada: el alumno ya no está inscrito en este NRC.';
}

/**
 * SNAPSHOT_INSCRITOS guarda la última ejecución; SNAPSHOT_INSCRITOS_BASE
 * guarda la última ejecución de un día anterior. Las altas/bajas siempre se
 * comparan contra la base, así que ejecutar varias veces el mismo día no
 * pierde los cambios del día.
 */
function compareSnapshots_(ss, ctx) {
  const today = ctx.todayKey;
  const header = ['RUT', 'NRC', 'CODIGO', 'TITULO', 'FECHA_SNAPSHOT'];

  const readSnap = name => {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return null;
    const data = sh.getDataRange().getValues();
    const rows = new Map();
    let date = '';
    for (let i = 1; i < data.length; i++) {
      const rut = cleanRut_(data[i][0]);
      const nrc = cleanNrc_(data[i][1]);
      if (!rut) continue;
      rows.set(`${rut}|${nrc}`, { rut, nrc, code: cleanCode_(data[i][2]), title: asText_(data[i][3]).trim() });
      if (!date) date = toDateKey_(data[i][4]);
    }
    return { rows, date };
  };

  const toValues = snapObj => Array.from(snapObj.rows.values()).map(r => [r.rut, r.nrc, r.code, r.title, snapObj.date]);

  const actual = readSnap(SH.SNAP_ACTUAL);
  let base;
  if (actual && actual.date && actual.date !== today) {
    base = actual;
    writeTable_(ss, SH.SNAP_BASE, header, toValues(base));
  } else {
    base = readSnap(SH.SNAP_BASE);
  }

  const cur = new Map();
  for (const r of ctx.ramos.rows) {
    const k = `${r.rut}|${r.nrc}`;
    if (!cur.has(k)) cur.set(k, { rut: r.rut, nrc: r.nrc, code: r.code, title: r.title });
  }
  writeTable_(ss, SH.SNAP_ACTUAL, header, toValues({ rows: cur, date: today }));
  hideSheet_(ss, SH.SNAP_ACTUAL);
  hideSheet_(ss, SH.SNAP_BASE);

  if (!base) return { baseDate: '', altas: [], bajas: [] };

  const altas = [];
  const bajas = [];
  for (const [k, r] of cur.entries()) if (!base.rows.has(k)) altas.push(r);
  for (const [k, r] of base.rows.entries()) if (!cur.has(k)) bajas.push(r);
  return { baseDate: base.date, altas, bajas };
}

/* =========================
   ESCRITURA DE SALIDAS
========================= */
function writeMainOutput_(ss, result, tracking) {
  const header = ['RUT'].concat(tracking.manualCols, MAIN_HEADERS_GENERATED);

  const issueOrder = {
    REQUISITOS_FALTANTES: 1,
    CODIGO_PLAN_INCORRECTO_Y_FALTAN_REQUISITOS: 2,
    CODIGO_PLAN_INCORRECTO: 3,
    CURSO_NO_PERTENECE_A_SU_PLAN: 4,
    ELECTIVO_NO_PERMITIDO: 5
  };
  const cases = result.cases.slice().sort((a, b) => {
    const ta = tracking.perCase.get(a.id).seguimiento.startsWith('PERSISTE') ? 1 : 0;
    const tb = tracking.perCase.get(b.id).seguimiento.startsWith('PERSISTE') ? 1 : 0;
    if (ta !== tb) return ta - tb;   // nuevos y reabiertos primero
    const ia = issueOrder[a.issue] || 9;
    const ib = issueOrder[b.issue] || 9;
    if (ia !== ib) return ia - ib;
    return a.rut.localeCompare(b.rut);
  });

  const rows = cases.map(c => {
    const t = tracking.perCase.get(c.id);
    return [c.rut]
      .concat(tracking.manualCols.map(m => t.manual[m]))
      .concat([
        t.seguimiento, t.primera,
        c.carrera, c.catalogo, c.plan, c.nrc, c.nrcCorrecto,
        c.codigo, c.titulo, c.issue, c.codEsperado, c.titEsperado,
        c.elecPool, c.elecPe, c.elecEspOk, c.flex, c.sct,
        c.reqAlumno, c.reqAlterno, c.detalle, c.mensaje,
        c.infoVerano, c.faltantes, c.notas, c.id
      ]);
  });

  const sh = writeTable_(ss, SH.OUT_MAIN, header, rows);
  const cMsg = header.indexOf('MENSAJE PARA ESTUDIANTE') + 1;
  if (cMsg > 0 && rows.length) {
    sh.getRange(1, cMsg, rows.length + 1, 1).setWrap(true).setVerticalAlignment('top');
    sh.setColumnWidth(cMsg, 520);
  }
}

function writeNoPlanOutput_(ss, result) {
  const header = ['RUT', 'CARRERA', 'CATALOGO', 'PLAN DEL ALUMNO', 'NRC', 'CODIGO INSCRITO', 'TITULO INSCRITO', 'MOTIVO'];
  const rows = result.noPlan
    .slice()
    .sort((a, b) => a.motivo.localeCompare(b.motivo) || a.codigo.localeCompare(b.codigo) || a.rut.localeCompare(b.rut))
    .map(r => [r.rut, r.carrera, r.catalogo, r.plan, r.nrc, r.codigo, r.titulo, r.motivo]);
  writeTable_(ss, SH.OUT_NOPLAN, header, rows);
}

function writeNrcCorrectosOutput_(ss, result) {
  const seen = new Set();
  const rows = [];
  for (const r of result.nrcRows) {
    const k = r.join('||');
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push(r);
  }
  writeTable_(ss, SH.OUT_NRC, ['RUT', 'TITULO', 'NRC INCORRECTO', 'NRC CORRECTO', 'OBS'], rows);
}

function writeCambiosOutput_(ss, ctx, tracking) {
  const header = ['TIPO_CAMBIO', 'RUT', 'CARRERA', 'NRC', 'CODIGO', 'TITULO', 'DETALLE'];
  const carr = rut => ctx.carreraByRut.get(rut) || '';
  const rows = [];

  for (const r of tracking.newTodayRecs) {
    rows.push([
      r.FECHA_REAPERTURA === ctx.todayKey && r.PRIMERA_DETECCION !== ctx.todayKey ? 'CASO REABIERTO' : 'CASO NUEVO',
      r.RUT, r.CARRERA, r.NRC, r['CODIGO INSCRITO'], r['TITULO INSCRITO'], r.ISSUE_TYPE
    ]);
  }
  for (const r of tracking.resolvedTodayRecs) {
    rows.push(['CASO RESUELTO', r.RUT, r.CARRERA, r.NRC, r['CODIGO INSCRITO'], r['TITULO INSCRITO'],
      `${r.ISSUE_TYPE}: ${r.MOTIVO_RESOLUCION}`]);
  }

  const baseTxt = tracking.snap.baseDate ? `vs. ${tracking.snap.baseDate}` : '';
  for (const r of tracking.snap.altas) rows.push(['INSCRIPCION NUEVA', r.rut, carr(r.rut), r.nrc, r.code, r.title, baseTxt]);
  for (const r of tracking.snap.bajas) rows.push(['INSCRIPCION ELIMINADA', r.rut, carr(r.rut), r.nrc, r.code, r.title, baseTxt]);

  writeTable_(ss, SH.OUT_CAMBIOS, header, rows);
}

function writeCappOutput_(ss, result) {
  writeTable_(ss, SH.OUT_CAPP,
    ['RUT', 'CARRERA', 'PLAN DEL ALUMNO', 'NRC', 'CODIGO INSCRITO', 'TITULO INSCRITO', 'REQUISITO ACREDITADO CON'],
    result.cappValidated);
}

function writeSctControlOutput_(ss, ctx) {
  const rows = [];
  for (const [rut, raw] of ctx.cum.sctRawByRut.entries()) {
    const fixed = ctx.cum.sctByRut.get(rut) || 0;
    if (Math.abs(raw - fixed) > 1e-9) {
      rows.push([rut, ctx.carreraByRut.get(rut) || '', raw, fixed, raw - fixed]);
    }
  }
  rows.sort((a, b) => b[4] - a[4]);
  writeTable_(ss, SH.OUT_SCT, ['RUT', 'CARRERA', 'SCT SUMA SIMPLE (ANTES)', 'SCT CORREGIDO', 'DIFERENCIA'], rows);
}

function writeResumenOutput_(ss, ctx, result, tracking, createdCfg, secs) {
  const rows = [];
  const add = (...r) => rows.push(r);
  const blank = () => rows.push([]);

  add('AUDITORÍA TOMA DE RAMOS');
  add('Fecha de ejecución', Utilities.formatDate(ctx.now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'));
  add('Duración (s)', secs);
  add('Inscripciones analizadas', ctx.ramos.rows.length);
  add('Alumnos inscritos', ctx.ramos.codesByRut.size);
  if (createdCfg.length) add('Configuración creada / actualizada', createdCfg.join(' · '));
  blank();

  add('PERIODO Y FUENTES');
  add('Período revisado', ctx.period);
  add('Información de verano', ctx.summerPeriod
    ? `Requerida (primer semestre): verano ${ctx.summerPeriod}, ${ctx.verano.rows.length} inscripciones`
    : 'No aplica (el período no termina en 10)');
  add('REPORTE', 'HOJA USADA', 'INFORMACIÓN OBTENIDA AL', 'FILAS');
  for (const s of ctx.sources) add(...s);
  blank();

  add('SEGUIMIENTO');
  add('Base de comparación (inscripciones)', tracking.snap.baseDate || 'Primera ejecución: sin base');
  add('Casos abiertos', result.cases.length);
  add('Casos nuevos hoy', tracking.newToday);
  add('Casos reabiertos hoy', tracking.reopenedToday);
  add('Casos resueltos hoy', tracking.resolvedToday);
  add('Inscripciones nuevas', tracking.snap.altas.length);
  add('Inscripciones eliminadas', tracking.snap.bajas.length);
  blank();

  add('CASOS ABIERTOS POR TIPO');
  const byIssue = new Map();
  for (const c of result.cases) incMap_(byIssue, c.issue);
  for (const [k, v] of sortedEntries_(byIssue)) add(k, v);
  add('Validados gracias a CAPP ADICIONAL', result.cappValidated.length);
  blank();

  add('CASOS ABIERTOS POR PLAN');
  const byPlan = new Map();
  for (const c of result.cases) incMap_(byPlan, c.plan);
  for (const [k, v] of sortedEntries_(byPlan)) add(k, v);
  blank();

  add('INSCRIPCIONES EXCLUIDAS (hoja EXCLUSIONES)');
  for (const [k, v] of sortedEntries_(result.excludedCount)) add(k, v);
  blank();

  add('CODIGOS NO PRESENTES EN PLAN POR MOTIVO');
  const byMotivo = new Map();
  for (const r of result.noPlan) incMap_(byMotivo, r.motivo);
  for (const [k, v] of sortedEntries_(byMotivo)) add(k, v);
  blank();

  add('SCT');
  add('Alumnos con SCT corregido (ver CONTROL_SCT)',
    Array.from(ctx.cum.sctRawByRut.entries()).filter(([r, v]) => Math.abs(v - (ctx.cum.sctByRut.get(r) || 0)) > 1e-9).length);
  blank();

  add('ALERTAS');
  if (!result.alerts.length) add('(sin alertas)');
  add('TIPO', 'RUT / DATO', 'DETALLE');
  for (const a of result.alerts) add(...a);
  blank();

  add('DETALLE CODIGOS NO PRESENTES (por código)');
  add('CODIGO', 'TITULO', 'MOTIVO', 'INSCRIPCIONES');
  const byCode = new Map();
  for (const r of result.noPlan) {
    const k = `${r.codigo}§${r.motivo}`;
    const prev = byCode.get(k) || { codigo: r.codigo, titulo: r.titulo, motivo: r.motivo, n: 0 };
    prev.n++;
    byCode.set(k, prev);
  }
  Array.from(byCode.values())
    .sort((a, b) => b.n - a.n || a.codigo.localeCompare(b.codigo))
    .forEach(x => add(x.codigo, x.titulo, x.motivo, x.n));

  const width = Math.max(...rows.map(r => r.length), 2);
  const values = rows.map(r => r.concat(Array(width - r.length).fill('')));

  const sh = getOrCreateSheet_(ss, SH.OUT_RESUMEN);
  sh.clearContents();
  sh.getRange(1, 1, values.length, width).setValues(values);
  sh.autoResizeColumns(1, width);
}

/* =========================
   UTILIDADES DE E/S
========================= */
function writeTable_(ss, name, header, rows) {
  const sh = getOrCreateSheet_(ss, name);
  sh.clearContents();
  const values = [header].concat(rows.map(r => {
    const out = r.slice(0, header.length);
    while (out.length < header.length) out.push('');
    return out;
  }));
  sh.getRange(1, 1, values.length, header.length).setValues(values);
  sh.getRange(1, 1, 1, header.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

function hideSheet_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (sh && !sh.isSheetHidden()) sh.hideSheet();
}

function headerIndex_(headerRow) {
  const m = new Map();
  for (let i = 0; i < headerRow.length; i++) {
    const key = asText_(headerRow[i]).trim().toUpperCase();
    if (key && !m.has(key)) m.set(key, i);
  }
  return m;
}

function mustCol_(headerMap, name) {
  const key = name.trim().toUpperCase();
  if (!headerMap.has(key)) throw new Error(`Falta columna requerida "${name}"`);
  return headerMap.get(key);
}

function mustColOneOf_(headerMap, candidates) {
  const idx = findColOneOf_(headerMap, candidates);
  if (idx === null) throw new Error(`Falta columna requerida (alguna de): ${candidates.join(', ')}`);
  return idx;
}

function findColOneOf_(headerMap, candidates) {
  for (const c of candidates) {
    const key = c.trim().toUpperCase();
    if (headerMap.has(key)) return headerMap.get(key);
  }
  return null;
}

function mustGetSheet_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error(`No existe hoja: "${name}"`);
  return sh;
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/* =========================
   FECHAS
========================= */
function runDate_() {
  return new Date();
}

function dateKey_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function toDateKey_(v) {
  if (v instanceof Date) return dateKey_(v);
  const s = asText_(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

function daysBetween_(fromKey, toKey) {
  const a = Date.UTC(+fromKey.slice(0, 4), +fromKey.slice(5, 7) - 1, +fromKey.slice(8, 10));
  const b = Date.UTC(+toKey.slice(0, 4), +toKey.slice(5, 7) - 1, +toKey.slice(8, 10));
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/* =========================
   NORMALIZACIÓN
========================= */
function asText_(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function cleanRut_(v) {
  let s = asText_(v).trim();
  if (!s) return '';
  if (s.endsWith('.0')) s = s.slice(0, -2);
  return s.toUpperCase().replace(/[^0-9K]/g, '');
}

function cleanCatalog_(v) {
  let s = asText_(v).trim();
  if (s.endsWith('.0')) s = s.slice(0, -2);
  return s;
}

function catalogNumber_(v) {
  const s = cleanCatalog_(v);
  return /^\d{6}$/.test(s) ? Number(s) : NaN;
}

function cleanCode_(v) {
  return asText_(v).trim().toUpperCase().replace(/\s+/g, '');
}

function cleanNrc_(v) {
  let s = asText_(v).trim();
  if (!s) return '';
  if (s.endsWith('.0')) s = s.slice(0, -2);
  return s;
}

function normalizeTitle_(s) {
  return asText_(s).toUpperCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function normalizeHeaderToken_(v) {
  return asText_(v).trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

function toNumberStrict_(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return v;
  const m = String(v).replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

function splitList_(v) {
  return asText_(v).split(/[,;|/]+/).map(x => x.trim()).filter(Boolean);
}

function parseListSet_(v) {
  return new Set(splitList_(v).map(x => x.toUpperCase()));
}

function stopwordsSet_() {
  if (!STOPWORDS_) STOPWORDS_ = new Set(['DE', 'LA', 'Y', 'E', 'AL', 'A', 'EL', 'LOS', 'LAS', 'DEL', 'PARA', 'EN', 'I', 'II', 'III']);
  return STOPWORDS_;
}
let STOPWORDS_ = null;

function unique_(arr) {
  return Array.from(new Set(arr));
}

function incMap_(m, k) {
  m.set(k, (m.get(k) || 0) + 1);
}

function sortedEntries_(m) {
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
}

/* =========================
   SPLITTERS / LEVENSHTEIN
========================= */
function splitTopLevelOr_(s) {
  const parts = [];
  let buf = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && s.substring(i, i + 3).toLowerCase() === ' o ') {
      parts.push(buf);
      buf = '';
      i += 2;
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts;
}

function splitTopLevel_(s, sep) {
  const parts = [];
  let buf = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && ch === sep) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  parts.push(buf);
  return parts;
}

function trimOuterParens_(s) {
  let t = asText_(s).trim();
  if (t.startsWith('(') && t.endsWith(')')) t = t.slice(1, -1).trim();
  return t;
}

function levenshteinSimilarity_(a, b) {
  return 1 - levenshteinDistance_(a, b) / Math.max(a.length, b.length, 1);
}

function levenshteinDistance_(a, b) {
  const n = a.length, m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const dp = new Array(m + 1);
  for (let j = 0; j <= m; j++) dp[j] = j;
  for (let i = 1; i <= n; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[m];
}
