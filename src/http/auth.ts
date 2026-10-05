const MAXIMUM_API_KEY_LENGTH = 1024;

async function hashApiKey(apiKey: string): Promise<Uint8Array> {
  const encodedKey = new TextEncoder().encode(apiKey);
  const digest = await crypto.subtle.digest('SHA-256', encodedKey);
  return new Uint8Array(digest);
}

export async function isAuthorized(
  providedApiKey: string | null,
  expectedApiKey: string,
): Promise<boolean> {
  if (!providedApiKey || providedApiKey.length > MAXIMUM_API_KEY_LENGTH) {
    return false;
  }

  const [providedHash, expectedHash] = await Promise.all([
    hashApiKey(providedApiKey),
    hashApiKey(expectedApiKey),
  ]);

  // Compare every byte of equal-length hashes; do not stop at the first mismatch.
  let difference = 0;

  for (let index = 0; index < providedHash.length; index++) {
    difference |= providedHash[index] ^ expectedHash[index];
  }

  return difference === 0;
}
