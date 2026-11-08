export function protectLegacyReceipt(
  originalBytes: Buffer,
  tenant: string,
  repository: string,
  key: Buffer,
): {
  id: number;
  originalCore: string;
  encryption: {
    version: number;
    algorithm: string;
    nonce: string;
    tag: string;
    ciphertext: string;
    ciphertextSha256: string;
    plaintextSha256: string;
  };
};
