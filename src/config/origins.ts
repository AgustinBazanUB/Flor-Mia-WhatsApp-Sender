import allowedOriginConfig from "../../config/allowed-origins.json";

const patterns = [...allowedOriginConfig.production, ...allowedOriginConfig.development];

function patternToOrigin(pattern: string): string {
  return pattern.replace(/\/\*$/, "");
}

export const WEB_APP_MATCH_PATTERNS = Object.freeze(patterns);
export const WEB_APP_ORIGINS = Object.freeze(patterns.map(patternToOrigin));

export function isAllowedWebAppOrigin(origin: string): boolean {
  return WEB_APP_ORIGINS.includes(origin);
}
