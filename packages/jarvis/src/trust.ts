// What a turn may open once it has read outside content (D25), and where it may act (D30). The
// checks live in the kernel, so every call made as Jarvis gets them, a reflex's included (D58);
// they're re-exported here under the names and signatures the browser and the runner use.
export { normalizeUrl, onSiteList, type SiteRules } from "@hearth/core";
export {
  checkActing,
  checkOpen,
  exactUrls,
  extractUrls,
  type OpenVerdict,
  readOutsideContent,
  type TrustState,
  vouchFor,
} from "@hearth/kernel";
