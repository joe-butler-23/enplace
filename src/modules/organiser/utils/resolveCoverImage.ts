import { App, TFile } from "@/platform";
import { OrganiserItem } from "../types";

function normalizeCoverImageValue(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	const wikiMatch = trimmed.match(/^!?\[\[(.+)\]\]$/);
	const inner = wikiMatch ? wikiMatch[1] : trimmed;
	const pathPart = inner.split("|")[0] ?? "";
	return pathPart.trim();
}

function isSafeCoverUrl(value: string): boolean {
	const lower = value.toLowerCase();
	if (
		lower.startsWith("http://") ||
		lower.startsWith("https://") ||
		lower.startsWith("app://") ||
		lower.startsWith("obsidian://")
	) {
		return true;
	}
	if (lower.startsWith("//")) return false;
	return !/^[a-z][a-z0-9+.-]*:/.test(lower);
}

function joinVaultPath(baseDir: string, relativePath: string): string {
	const parts = [...baseDir.split("/"), ...relativePath.split("/")];
	const resolved: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") {
			resolved.pop();
			continue;
		}
		resolved.push(part);
	}
	return resolved.join("/");
}

export function resolveCoverImage(app: App, item: OrganiserItem): string {
	const rawCoverImage =
		typeof item.coverImage === "string" ? item.coverImage.trim() : "";
	if (!rawCoverImage) return "";

	const normalized = normalizeCoverImageValue(rawCoverImage).replace(
		/\\/g,
		"/"
	);
	if (!normalized || !isSafeCoverUrl(normalized)) return "";

	const lower = normalized.toLowerCase();
	if (
		lower.startsWith("http://") ||
		lower.startsWith("https://") ||
		lower.startsWith("app://") ||
		lower.startsWith("obsidian://")
	) {
		return normalized;
	}

	const vaultPath = normalized.replace(/^\.\/+/, "").replace(/^\/+/, "");
	let file = app.vault.getAbstractFileByPath(vaultPath);
	if (file instanceof TFile) {
		return app.vault.getResourcePath(file);
	}

	const baseDir = item.path.includes("/")
		? item.path.slice(0, item.path.lastIndexOf("/"))
		: "";
	const resolvedPath = baseDir
		? joinVaultPath(baseDir, vaultPath)
		: vaultPath;
	file = app.vault.getAbstractFileByPath(resolvedPath);
	if (file instanceof TFile) {
		return app.vault.getResourcePath(file);
	}

	return "";
}
