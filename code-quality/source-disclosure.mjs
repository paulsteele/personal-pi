export const SENSITIVE_PATH_PATTERN =
	/(?:^|[/\\])(?:\.env(?:\..+)?|auth\.json|credentials(?:\.json)?|id_(?:rsa|ed25519)|[^/\\]+\.(?:pem|key|p12))$/i;
export const SECRET_PATTERN =
	/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{16,}|\bAKIA[A-Z0-9]{16}\b|\bBearer\s+[A-Za-z0-9._~-]{20,}/;
export function sensitivePath(path) {
	return SENSITIVE_PATH_PATTERN.test(path);
}
export function containsSecrets(text) {
	return SECRET_PATTERN.test(text);
}
