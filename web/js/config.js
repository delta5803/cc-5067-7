export const DEFAULT_CONFIG = {
  width: 1.25,        // M/S side gain: 0 = mono, 1 = unity, up to 2.5
  decorr: 0.32,       // wet decorrelation amount 0..1
  structure: 'ap',    // ms | ap | delay | haas
  delayMs: 6,
  haasMs: 9,
  apCharacter: 1,
  stageMode: 'crossover', // preserve | widen | crossover
  crossover: true,
  fc: 180,
  lowMode: 'auto',    // auto | center | rescue | preserve
  broadcast: 'auto',  // auto | direct_mid | fold_stage | phase_safe
  autoProtect: true,
  centerLock: true,   // orthogonalize decorr send vs M to hold center/balance
  outGainDb: 0,
  foldPolarity: 'plain', // plain | auto (auto = correct inverted channel on the monitor fold)
};

export const STRUCTURE_LABELS = {
  ms: '仅 M/S 增益（无去相关）',
  ap: '全通链去相关',
  delay: '短延迟去相关',
  haas: '非对称 Haas 延迟（单声道梳状）',
};

export const STAGE_MODE_LABELS = {
  preserve: '保留原侧声（旁通）',
  widen: '全带扩宽',
  crossover: '分频旁路：低频居中 / 高频扩宽',
};

export const BROADCAST_LABELS = {
  auto: '自动相位政策',
  direct_mid: '独立中轨 M 直送',
  fold_stage: '舞台声折叠 (L+R)/2',
  phase_safe: '相位安全单声道（低频选 M/S）',
};

// Side-channel policy that travels with the project. The monitor fold and the
// broadcast feed both resolve their low-frequency handling from this set; the
// panel persists it so a reload auditions the same policy it last saved.
export const PROJECT_POLICY_KEY = 'sw-project-side-policy-v1';
export const POLICY_FIELDS = [
  'width', 'structure', 'decorr', 'delayMs', 'haasMs', 'crossover', 'fc',
  'lowMode', 'broadcast', 'centerLock', 'autoProtect', 'stageMode', 'foldPolarity',
];

const STAGE_MODES = new Set(['preserve', 'widen', 'crossover']);
const STRUCTURES = new Set(['ms', 'ap', 'delay', 'haas']);
const LOW_MODES = new Set(['auto', 'center', 'rescue', 'preserve']);
const BROADCAST_ROUTES = new Set(['auto', 'direct_mid', 'fold_stage', 'phase_safe']);
const FOLD_POLARITIES = new Set(['plain', 'auto']);

function clampNumber(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
}

// localStorage is an external boundary: validate every field, drop unknown
// keys, and let the caller merge the result over DEFAULT_CONFIG.
export function sanitizePolicy(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  const num = (key, lo, hi) => {
    const v = clampNumber(raw[key], lo, hi);
    if (v !== null) out[key] = v;
  };
  num('width', 0, 2.5);
  num('decorr', 0, 1);
  num('delayMs', 1, 24);
  num('haasMs', 2, 30);
  num('fc', 80, 800);
  if (STRUCTURES.has(raw.structure)) out.structure = raw.structure;
  if (LOW_MODES.has(raw.lowMode)) out.lowMode = raw.lowMode;
  if (BROADCAST_ROUTES.has(raw.broadcast)) out.broadcast = raw.broadcast;
  if (STAGE_MODES.has(raw.stageMode)) out.stageMode = raw.stageMode;
  if (FOLD_POLARITIES.has(raw.foldPolarity)) out.foldPolarity = raw.foldPolarity;
  for (const key of ['crossover', 'centerLock', 'autoProtect']) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  return Object.keys(out).length ? out : null;
}

export function pickPolicy(config = {}) {
  const out = {};
  for (const key of POLICY_FIELDS) {
    if (config[key] !== undefined) out[key] = config[key];
  }
  return sanitizePolicy(out) || {};
}

export function loadProjectPolicy(storage) {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) return null;
  try {
    const raw = store.getItem(PROJECT_POLICY_KEY);
    if (!raw) return null;
    return sanitizePolicy(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveProjectPolicy(config, storage) {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) return null;
  const policy = pickPolicy(config);
  try {
    store.setItem(PROJECT_POLICY_KEY, JSON.stringify(policy));
  } catch {
    return null;
  }
  return policy;
}

export function clearProjectPolicy(storage) {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) return;
  try { store.removeItem(PROJECT_POLICY_KEY); } catch { /* ignore */ }
}
