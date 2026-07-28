/**
 * Minimalne środowisko dla zewnętrznych CLI. Proces Mastry ma tokeny Lineara,
 * storage i powiadomień; agent nie potrzebuje ich do pracy w repo i nie może ich
 * dziedziczyć przypadkiem przez `execFile`.
 *
 * SSH_AUTH_SOCK celowo NIE przechodzi: agent (i wykonywany w teście kod
 * z agent-modyfikowanego repo) nie może używać żywego agenta SSH właściciela.
 * Push/publish robi fabryka własnym procesem z pełnym env.
 */
const SAFE_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "NO_COLOR",
] as const;

export function engineEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  // Proxy jest częścią transportu sieciowego, nie sekretem aplikacji.
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] as const) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}
