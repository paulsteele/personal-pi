export const SENSITIVE_PATH_PATTERN: RegExp;
export const SECRET_PATTERN: RegExp;
export function sensitivePath(path: string): boolean;
export function containsSecrets(text: string): boolean;
