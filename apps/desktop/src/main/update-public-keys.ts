/**
 * 应用内更新信任的 Ed25519 公钥（32 字节原始公钥的 base64）。
 * 私钥由维护者离线保管（见 docs/updates.md），发版时用它给 SHA256SUMS.txt 签名。
 * 轮换密钥：先发一个同时包含新旧公钥的版本，之后再改用新私钥签名。
 */
export const updatePublicKeys: readonly string[] = [
  "ccoisxy5w7M/CXHUj/obm1llcEsKCX4g9kDUVGUcV+E=",
];
