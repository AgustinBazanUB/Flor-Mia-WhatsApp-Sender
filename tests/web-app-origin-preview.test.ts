import { describe, expect, it } from "vitest";
import {
  isAllowedWebAppOrigin,
  WEB_APP_PREVIEW_INCLUDE_GLOBS,
  WEB_APP_PREVIEW_MATCH_PATTERN
} from "../src/config/origins";

describe("Flor Mía Web App origin policy", () => {
  it("accepts production and the current Deploy Preview 15", () => {
    expect(isAllowedWebAppOrigin("https://appintegralflormia.netlify.app")).toBe(true);
    expect(isAllowedWebAppOrigin("https://deploy-preview-15--appintegralflormia.netlify.app")).toBe(true);
    expect(isAllowedWebAppOrigin("https://deploy-preview-15--app-integral-fm.netlify.app")).toBe(true);
  });

  it("accepts future numeric Flor Mía Deploy Previews without hardcoding their number", () => {
    expect(isAllowedWebAppOrigin("https://deploy-preview-99--appintegralflormia.netlify.app")).toBe(true);
    expect(isAllowedWebAppOrigin("https://deploy-preview-314--app-integral-fm.netlify.app")).toBe(true);
  });

  it("rejects unrelated Netlify sites and malformed preview hosts", () => {
    expect(isAllowedWebAppOrigin("https://deploy-preview-15--otro-sitio.netlify.app")).toBe(false);
    expect(isAllowedWebAppOrigin("https://deploy-preview-latest--appintegralflormia.netlify.app")).toBe(false);
    expect(isAllowedWebAppOrigin("https://appintegralflormia.example.com")).toBe(false);
    expect(isAllowedWebAppOrigin("http://deploy-preview-15--appintegralflormia.netlify.app")).toBe(false);
  });

  it("keeps the manifest preview match broad only at match level and narrows it with include globs", () => {
    expect(WEB_APP_PREVIEW_MATCH_PATTERN).toBe("https://*.netlify.app/*");
    expect(WEB_APP_PREVIEW_INCLUDE_GLOBS).toContain("https://deploy-preview-*--appintegralflormia.netlify.app/*");
    expect(WEB_APP_PREVIEW_INCLUDE_GLOBS).toContain("https://deploy-preview-*--app-integral-fm.netlify.app/*");
  });
});
