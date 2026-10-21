/**
 * Main-process translations (native menu bar, tray menu, modal dialogs and the
 * file-dialog filters). Kept separate from the renderer dictionary because it is
 * bundled by tsc for the Electron main process rather than by Angular.
 */

export type Lang = 'pt' | 'en' | 'es' | 'fr';

/**
 * Product name. Keep in sync with `productName` in package.json and with
 * `APP_NAME` in src/app/i18n.ts. Every `{app}` placeholder below is replaced by
 * this string when the dictionaries are built.
 */
export const APP_NAME = 'DriverSize';

/** Selectable UI languages, in menu order. */
export const LANGS: { id: Lang; name: string }[] = [
  { id: 'pt', name: 'Português' },
  { id: 'en', name: 'English' },
  { id: 'es', name: 'Español' },
  { id: 'fr', name: 'Français' },
];

export interface MainDict {
  // menu bar
  file: string;
  scan: string;
  view: string;
  help: string;
  // File
  mnNew: string;
  mnLoad: string;
  mnSave: string;
  mnExportChart: string;
  mnExportAs: string;
  mnExportDetails: string;
  mnOptions: string;
  mnPrintTree: string;
  mnPrintDetails: string;
  mnExit: string;
  // Scan
  mnScanDrive: string;
  mnScanFolder: string;
  mnStopScan: string;
  mnFilter: string;
  // Tools
  tools: string;
  mnDupes: string;
  mnCleanup: string;
  mnInspect: string;
  mnFind: string;
  // View
  mnSize: string;
  mnLanguage: string;
  mnDriveInfo: string;
  mnChart: string;
  // Help
  mnHelp: string;
  mnAbout: string;
  // tray
  trayOpen: string;
  trayRescan: string;
  trayQuit: string;
  // confirmation + fallback context menu
  dlgDeleteOne: string;
  dlgDeleteMany: string;
  dlgCancel: string;
  dlgDelete: string;
  mnOpen: string;
  mnOpenN: string;
  mnOpenWith: string;
  mnReveal: string;
  mnCopyPath: string;
  mnCopyPaths: string;
  mnRename: string;
  mnDeleteOne: string;
  mnDeleteMany: string;
  mnProperties: string;
  mnFullShell: string;
  // file-dialog filters
  fltCsv: string;
  fltXml: string;
  fltPng: string;
  fltSession: string;
  fltHtml: string;
  // errors
  errBusy: string;
  errCannotRead: string;
  errBadSession: string;
}

const PT: MainDict = {
  file: 'Arquivo',
  scan: 'Varredura',
  view: 'Exibir',
  help: 'Ajuda',
  mnNew: 'Novo...',
  mnLoad: 'Abrir...',
  mnSave: 'Salvar...',
  mnExportChart: 'Exportar imagem do gráfico...',
  mnExportAs: 'Exportar como...',
  mnExportDetails: 'Exportar lista de detalhes...',
  mnOptions: 'Opções...',
  mnPrintTree: 'Imprimir árvore de pastas...',
  mnPrintDetails: 'Imprimir lista de detalhes...',
  mnExit: 'Sair',
  mnScanDrive: 'Analisar unidade selecionada',
  mnScanFolder: 'Analisar pasta...',
  mnStopScan: 'Parar análise',
  mnFilter: 'Filtro...',
  tools: 'Ferramentas',
  mnDupes: 'Duplicados...',
  mnCleanup: 'Limpeza segura...',
  mnFind: 'Busca global...',
  mnInspect: 'Inspecionar elemento...',
  mnSize: 'Tamanho',
  mnLanguage: 'Idioma',
  mnDriveInfo: 'Info da unidade',
  mnChart: 'Gráfico',
  mnHelp: 'Ajuda',
  mnAbout: 'Sobre',
  trayOpen: 'Abrir {app}',
  trayRescan: 'Resscanear',
  trayQuit: 'Sair',
  dlgDeleteOne: 'Mover para a Lixeira?',
  dlgDeleteMany: 'Mover {n} itens para a Lixeira?',
  dlgCancel: 'Cancelar',
  dlgDelete: 'Excluir',
  mnOpen: 'Abrir',
  mnOpenN: 'Abrir ({n})',
  mnOpenWith: 'Abrir com…',
  mnReveal: 'Mostrar no Explorer',
  mnCopyPath: 'Copiar caminho',
  mnCopyPaths: 'Copiar {n} caminhos',
  mnRename: 'Renomear…',
  mnDeleteOne: 'Excluir (Lixeira)',
  mnDeleteMany: 'Excluir {n} itens (Lixeira)',
  mnProperties: 'Propriedades',
  mnFullShell: 'Menu do Windows (completo)…',
  fltCsv: 'CSV (valores separados por vírgula)',
  fltXml: 'XML',
  fltPng: 'Imagem PNG',
  fltSession: '{app} (varredura)',
  fltHtml: 'HTML',
  errBusy: 'Já existe uma varredura em andamento',
  errCannotRead: 'Não é possível ler {path}: {msg}',
  errBadSession: 'arquivo de varredura inválido',
};

const EN: MainDict = {
  file: 'File',
  scan: 'Scan',
  view: 'View',
  help: 'Help',
  mnNew: 'New...',
  mnLoad: 'Load...',
  mnSave: 'Save...',
  mnExportChart: 'Export Chart Image...',
  mnExportAs: 'Export As...',
  mnExportDetails: 'Export Details View...',
  mnOptions: 'Options...',
  mnPrintTree: 'Print Folder Tree...',
  mnPrintDetails: 'Print Details View...',
  mnExit: 'Exit',
  mnScanDrive: 'Scan Selected Drive',
  mnScanFolder: 'Scan Folder...',
  mnStopScan: 'Stop Scan',
  mnFilter: 'Filter...',
  tools: 'Tools',
  mnDupes: 'Duplicates...',
  mnCleanup: 'Safe cleanup...',
  mnFind: 'Global search...',
  mnInspect: 'Inspect element...',
  mnSize: 'Size',
  mnLanguage: 'Language',
  mnDriveInfo: 'Drive Info',
  mnChart: 'Chart',
  mnHelp: 'Help',
  mnAbout: 'About',
  trayOpen: 'Open {app}',
  trayRescan: 'Rescan',
  trayQuit: 'Exit',
  dlgDeleteOne: 'Move to the Recycle Bin?',
  dlgDeleteMany: 'Move {n} items to the Recycle Bin?',
  dlgCancel: 'Cancel',
  dlgDelete: 'Delete',
  mnOpen: 'Open',
  mnOpenN: 'Open ({n})',
  mnOpenWith: 'Open with…',
  mnReveal: 'Show in Explorer',
  mnCopyPath: 'Copy path',
  mnCopyPaths: 'Copy {n} paths',
  mnRename: 'Rename…',
  mnDeleteOne: 'Delete (Recycle Bin)',
  mnDeleteMany: 'Delete {n} items (Recycle Bin)',
  mnProperties: 'Properties',
  mnFullShell: 'Windows Menu (full)…',
  fltCsv: 'CSV (comma separated values)',
  fltXml: 'XML',
  fltPng: 'PNG image',
  fltSession: '{app} (scan)',
  fltHtml: 'HTML',
  errBusy: 'A scan is already running',
  errCannotRead: 'Cannot read {path}: {msg}',
  errBadSession: 'invalid scan file',
};

const ES: MainDict = {
  file: 'Archivo',
  scan: 'Análisis',
  view: 'Ver',
  help: 'Ayuda',
  mnNew: 'Nuevo...',
  mnLoad: 'Abrir...',
  mnSave: 'Guardar...',
  mnExportChart: 'Exportar imagen del gráfico...',
  mnExportAs: 'Exportar como...',
  mnExportDetails: 'Exportar lista de detalles...',
  mnOptions: 'Opciones...',
  mnPrintTree: 'Imprimir árbol de carpetas...',
  mnPrintDetails: 'Imprimir lista de detalles...',
  mnExit: 'Salir',
  mnScanDrive: 'Analizar la unidad seleccionada',
  mnScanFolder: 'Analizar carpeta...',
  mnStopScan: 'Detener el análisis',
  mnFilter: 'Filtro...',
  tools: 'Herramientas',
  mnDupes: 'Duplicados...',
  mnCleanup: 'Limpieza segura...',
  mnFind: 'Búsqueda global...',
  mnInspect: 'Inspeccionar elemento...',
  mnSize: 'Tamaño',
  mnLanguage: 'Idioma',
  mnDriveInfo: 'Info de la unidad',
  mnChart: 'Gráfico',
  mnHelp: 'Ayuda',
  mnAbout: 'Acerca de',
  trayOpen: 'Abrir {app}',
  trayRescan: 'Reanalizar',
  trayQuit: 'Salir',
  dlgDeleteOne: '¿Mover a la Papelera de reciclaje?',
  dlgDeleteMany: '¿Mover {n} elementos a la Papelera de reciclaje?',
  dlgCancel: 'Cancelar',
  dlgDelete: 'Eliminar',
  mnOpen: 'Abrir',
  mnOpenN: 'Abrir ({n})',
  mnOpenWith: 'Abrir con…',
  mnReveal: 'Mostrar en el Explorador',
  mnCopyPath: 'Copiar ruta',
  mnCopyPaths: 'Copiar {n} rutas',
  mnRename: 'Cambiar nombre…',
  mnDeleteOne: 'Eliminar (Papelera)',
  mnDeleteMany: 'Eliminar {n} elementos (Papelera)',
  mnProperties: 'Propiedades',
  mnFullShell: 'Menú de Windows (completo)…',
  fltCsv: 'CSV (valores separados por comas)',
  fltXml: 'XML',
  fltPng: 'Imagen PNG',
  fltSession: '{app} (análisis)',
  fltHtml: 'HTML',
  errBusy: 'Ya hay un análisis en curso',
  errCannotRead: 'No se puede leer {path}: {msg}',
  errBadSession: 'archivo de análisis no válido',
};

const FR: MainDict = {
  file: 'Fichier',
  scan: 'Analyse',
  view: 'Affichage',
  help: 'Aide',
  mnNew: 'Nouveau...',
  mnLoad: 'Ouvrir...',
  mnSave: 'Enregistrer...',
  mnExportChart: 'Exporter l’image du graphique...',
  mnExportAs: 'Exporter sous...',
  mnExportDetails: 'Exporter la liste détaillée...',
  mnOptions: 'Options...',
  mnPrintTree: 'Imprimer l’arborescence...',
  mnPrintDetails: 'Imprimer la liste détaillée...',
  mnExit: 'Quitter',
  mnScanDrive: 'Analyser le lecteur sélectionné',
  mnScanFolder: 'Analyser un dossier...',
  mnStopScan: 'Arrêter l’analyse',
  mnFilter: 'Filtre...',
  tools: 'Outils',
  mnDupes: 'Doublons...',
  mnCleanup: 'Nettoyage sûr...',
  mnFind: 'Recherche globale...',
  mnInspect: 'Inspecter l’élément...',
  mnSize: 'Taille',
  mnLanguage: 'Langue',
  mnDriveInfo: 'Infos du lecteur',
  mnChart: 'Graphique',
  mnHelp: 'Aide',
  mnAbout: 'À propos',
  trayOpen: 'Ouvrir {app}',
  trayRescan: 'Réanalyser',
  trayQuit: 'Quitter',
  dlgDeleteOne: 'Mettre à la corbeille ?',
  dlgDeleteMany: 'Mettre {n} éléments à la corbeille ?',
  dlgCancel: 'Annuler',
  dlgDelete: 'Supprimer',
  mnOpen: 'Ouvrir',
  mnOpenN: 'Ouvrir ({n})',
  mnOpenWith: 'Ouvrir avec…',
  mnReveal: 'Afficher dans l’Explorateur',
  mnCopyPath: 'Copier le chemin',
  mnCopyPaths: 'Copier {n} chemins',
  mnRename: 'Renommer…',
  mnDeleteOne: 'Supprimer (corbeille)',
  mnDeleteMany: 'Supprimer {n} éléments (corbeille)',
  mnProperties: 'Propriétés',
  mnFullShell: 'Menu Windows (complet)…',
  fltCsv: 'CSV (valeurs séparées par des virgules)',
  fltXml: 'XML',
  fltPng: 'Image PNG',
  fltSession: '{app} (analyse)',
  fltHtml: 'HTML',
  errBusy: 'Une analyse est déjà en cours',
  errCannotRead: 'Impossible de lire {path} : {msg}',
  errBadSession: 'fichier d’analyse invalide',
};

/** Replace the `{app}` placeholders of one dictionary. */
function withAppName(d: MainDict): MainDict {
  const out = { ...d };
  for (const k of Object.keys(out) as (keyof MainDict)[]) out[k] = fill(out[k], { app: APP_NAME });
  return out;
}

export const MAIN: Record<Lang, MainDict> = {
  pt: withAppName(PT),
  en: withAppName(EN),
  es: withAppName(ES),
  fr: withAppName(FR),
};

/** Maps any locale tag ("pt-BR", "es-419", …) to one of the supported languages. */
export function matchLang(tag: string): Lang {
  const l = (tag || '').toLowerCase();
  if (l.startsWith('pt')) return 'pt';
  if (l.startsWith('es')) return 'es';
  if (l.startsWith('fr')) return 'fr';
  return 'en';
}

export function isLang(v: unknown): v is Lang {
  return v === 'pt' || v === 'en' || v === 'es' || v === 'fr';
}

/** `fill('Mover {n} itens…', { n: 3 })` */
export function fill(s: string, params: Record<string, string | number>): string {
  let out = s;
  for (const [k, v] of Object.entries(params)) out = out.split('{' + k + '}').join(String(v));
  return out;
}
