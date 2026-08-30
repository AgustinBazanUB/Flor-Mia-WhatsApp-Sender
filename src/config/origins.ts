import allowedOriginConfig from "../../config/allowed-origins.json";

const exactPatterns = [...allowedOriginConfig.production, ...allowedOriginConfig.development];
const previewSiteNames = new Set(allowedOriginConfig.preview.siteNames.map((item) => item.toLowerCase()));

function patternToOrigin(pattern: string): string {
  return pattern.replace(/\/\*$/, "");
}

function isAllowedNetlifyPreview(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port) return false;
  const match = /^deploy-preview-(\d+)--([a-z0-9-]+)\.netlify\.app$/i.exec(url.hostname);
  if (!match) return false;
  return previewSiteNames.has(match[2].toLowerCase());
}

export const WEB_APP_MATCH_PATTERNS = Object.freeze(exactPatterns);
export const WEB_APP_ORIGINS = Object.freeze(exactPatterns.map(patternToOrigin));
export const WEB_APP_PREVIEW_MATCH_PATTERN = allowedOriginConfig.preview.matchPattern;
export const WEB_APP_PREVIEW_INCLUDE_GLOBS = Object.freeze([...allowedOriginConfig.preview.includeGlobs]);

export function isAllowedWebAppOrigin(origin: string): boolean {
  return WEB_APP_ORIGINS.includes(origin) || isAllowedNetlifyPreview(origin);
}
