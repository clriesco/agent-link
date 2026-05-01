let liveCfg: unknown = null;

export function setLiveCfg(cfg: unknown): void {
  liveCfg = cfg;
}

export function getLiveCfg(): unknown {
  return liveCfg;
}
