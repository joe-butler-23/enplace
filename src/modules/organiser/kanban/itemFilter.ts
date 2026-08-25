import { CachedMetadata, getAllTags, TFile } from "@/platform";
import { ItemFilter } from "../types/kanban-config";

export function matchesItemFilter(
	file: TFile,
	cache: CachedMetadata | null | undefined,
	filter?: ItemFilter
): boolean {
	if (!filter) return true;

	const frontmatter = cache?.frontmatter || {};
	const { pathPattern, requiredTags, requiredFields, customFilter } = filter;

	if (pathPattern && !pathPattern.test(file.path)) return false;

	if (requiredTags) {
		const fileTags = cache ? getAllTags(cache) ?? [] : [];
		const fileTagSet = new Set(fileTags);
		const hasTags = requiredTags.some((tag) => fileTagSet.has(tag));
		if (!hasTags) return false;
	}

	if (requiredFields) {
		const hasFields = requiredFields.every(
			(field) => frontmatter[field] !== undefined
		);
		if (!hasFields) return false;
	}

	if (customFilter && !customFilter(file, frontmatter)) return false;

	return true;
}
