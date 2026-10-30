export function isUsableModelCatalog(value) {
  if (!value || !Array.isArray(value.models) || value.models.length === 0) return false;
  const slugs = new Set();
  return value.models.every((model) => {
    const slug = typeof model?.slug === "string" ? model.slug.trim() : "";
    if (!slug || slugs.has(slug)) return false;
    slugs.add(slug);
    return true;
  });
}
