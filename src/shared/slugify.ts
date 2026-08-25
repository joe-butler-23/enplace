export function slugify(
	value: string,
	opts?: { maxLength?: number; fallback?: string }
): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const limited = opts?.maxLength ? slug.slice(0, opts.maxLength) : slug;
	return limited || opts?.fallback || "";
}
