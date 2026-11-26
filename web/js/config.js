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
};

export const STRUCTURE_LABELS = {
  ms: '仅 M/S 增益（单声道安全）',
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
