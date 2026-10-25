/**
 * Shared Penumbra site header markup. Keep in sync with index.html, guide.html, web.html, layers.html.
 *
 * - index: view tabs are <button data-tab> (in-page); other pages use <a href="./?tab=…">.
 * - Set aria-current="page" on the active secondary-page link (Tour / DES filaments / Layer viewer).
 * - Full-screen viewers: header class includes `overlay`; Tour uses sticky `pb-bar` only.
 * - Room toggle: index + layer viewer only (SpacetimeDB collab).
 */
export type SitePage = 'tour' | 'web' | 'layers';

export const VIEW_TAB_LINKS = [
  { tab: 'sim', label: 'Simulate' },
  { tab: 'box', label: '3D map' },
  { tab: 'slices', label: 'Survey slices' },
] as const;

export const PAGE_TAB_LINKS: { page: SitePage; href: string; label: string }[] = [
  { page: 'tour', href: 'guide.html', label: 'Tour' },
  { page: 'web', href: 'web.html', label: 'DES filaments' },
  { page: 'layers', href: 'layers.html', label: 'Layer viewer' },
];
