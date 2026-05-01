/**
 * pi-skill-palette
 *
 * A VS Code/Amp-style command palette for quickly selecting and applying skills.
 * Usage: /skill - Opens the skill picker overlay
 *
 * When a skill is selected, it's queued and the skill content is sent
 * alongside your next message automatically.
 *
 * https://github.com/nicobailon/pi-skill-palette
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, Container, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface Skill {
	name: string;
	description: string;
	filePath: string;
}

interface SkillPaletteState {
	queuedSkills: Skill[];
}

// Shared state across the extension
const state: SkillPaletteState = {
	queuedSkills: [],
};

// ═══════════════════════════════════════════════════════════════════════════
// Theming
// ═══════════════════════════════════════════════════════════════════════════

interface PaletteTheme {
	border: string;        // Box borders
	title: string;         // Title text
	selected: string;      // Selected item highlight
	selectedText: string;  // Selected item text
	queued: string;        // Queued badge
	searchIcon: string;    // Search icon
	placeholder: string;   // Placeholder text
	description: string;   // Skill descriptions
	hint: string;          // Footer hints
}

const DEFAULT_THEME: PaletteTheme = {
	border: "2",           // dim
	title: "2",            // dim
	selected: "36",        // cyan
	selectedText: "36",    // cyan
	queued: "32",          // green
	searchIcon: "2",       // dim
	placeholder: "2;3",    // dim italic
	description: "2",      // dim
	hint: "2",             // dim
};

function loadTheme(): PaletteTheme {
	const configPath = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-skill-palette", "theme.json");
	try {
		if (fs.existsSync(configPath)) {
			const content = fs.readFileSync(configPath, "utf-8");
			const custom = JSON.parse(content) as Partial<PaletteTheme>;
			return { ...DEFAULT_THEME, ...custom };
		}
	} catch {
		// Ignore errors, use default
	}
	return DEFAULT_THEME;
}

function fg(code: string, text: string): string {
	if (!code) return text;
	// Handle compound codes like "2;3" (dim + italic)
	return `\x1b[${code}m${text}\x1b[0m`;
}

// Rainbow colors (matching powerline-footer thinking:high)
const RAINBOW_COLORS = [
	"38;2;178;129;214",  // #b281d6 purple
	"38;2;215;135;175",  // #d787af pink
	"38;2;254;188;56",   // #febc38 orange
	"38;2;228;192;15",   // #e4c00f yellow
	"38;2;137;210;129",  // #89d281 green
	"38;2;0;175;175",    // #00afaf cyan
	"38;2;23;143;185",   // #178fb9 blue
];

// Render spaced rainbow progress dots
function rainbowProgress(filled: number, total: number): string {
	const dots: string[] = [];
	for (let i = 0; i < total; i++) {
		const color = RAINBOW_COLORS[i % RAINBOW_COLORS.length];
		const dot = i < filled ? "●" : "○";
		dots.push(fg(color, dot));
	}
	return dots.join(" ");
}

// Load theme once at startup
const paletteTheme = loadTheme();

type SkillFormat = "recursive" | "claude";

interface SkillDirConfig {
	dir: string;
	format: SkillFormat;
}

/**
 * Scan a directory for skills based on the format
 * - "recursive": scans directories recursively looking for SKILL.md files
 * - "claude": only scans one level deep (directories directly containing SKILL.md)
 */
function scanSkillDir(
	dir: string,
	format: SkillFormat,
	skillsByName: Map<string, Skill>,
	visitedDirs?: Set<string>
): void {
	if (!fs.existsSync(dir)) return;

	// Track visited directories by realpath to detect symlink cycles
	const visited = visitedDirs ?? new Set<string>();
	let realDir: string;
	try {
		realDir = fs.realpathSync(dir);
	} catch {
		realDir = dir;
	}
	if (visited.has(realDir)) return;
	visited.add(realDir);

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const entryPath = path.join(dir, entry.name);

			// Handle symlinks
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = fs.statSync(entryPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue; // Broken symlink
				}
			}

			if (format === "recursive") {
				// Recursive format: scan directories, look for SKILL.md files anywhere
				if (isDirectory) {
					scanSkillDir(entryPath, format, skillsByName, visited);
				} else if (isFile && entry.name === "SKILL.md") {
					loadSkillFromFile(entryPath, skillsByName);
				}
			} else if (format === "claude") {
				// Claude format: only one level deep, each directory must contain SKILL.md
				if (!isDirectory) continue;

				const skillFile = path.join(entryPath, "SKILL.md");
				if (!fs.existsSync(skillFile)) continue;

				loadSkillFromFile(skillFile, skillsByName);
			}
		}
	} catch {
		// Skip inaccessible directories
	}
}

/**
 * Load a single skill from a SKILL.md file
 */
function loadSkillFromFile(filePath: string, skillsByName: Map<string, Skill>): void {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const skillDir = path.dirname(filePath);
		const parentDirName = path.basename(skillDir);
		const { name, description } = parseFrontmatter(content, parentDirName);
		
		if (description && !skillsByName.has(name)) {
			// First occurrence wins (earlier sources take precedence)
			skillsByName.set(name, {
				name,
				description,
				filePath,
			});
		}
	} catch {
		// Skip invalid skill files
	}
}

/**
 * Load skills from known directories
 * Matches pi's skill loading order:
 * 1. ~/.agents/skills (recursive)
 * 2. ${cwd}/.agents/skills (claude format - one level)
 * 3. ~/.codex/skills (recursive)
 * 4. ~/.claude/skills (claude format - one level)
 * 5. ${cwd}/.claude/skills (claude format - one level)
 * 6. ~/.pi/agent/skills (recursive)
 * 7. ${cwd}/.pi/skills (recursive)
 */
function loadSkills(): Skill[] {
	const skillsByName = new Map<string, Skill>();
	
	const skillDirs: SkillDirConfig[] = [
		{ dir: path.join(os.homedir(), ".agents", "skills"), format: "recursive" },
		{ dir: path.join(process.cwd(), ".agents", "skills"), format: "claude" },
		{ dir: path.join(os.homedir(), ".codex", "skills"), format: "recursive" },
		{ dir: path.join(os.homedir(), ".claude", "skills"), format: "claude" },
		{ dir: path.join(process.cwd(), ".claude", "skills"), format: "claude" },
		{ dir: path.join(os.homedir(), ".pi", "agent", "skills"), format: "recursive" },
		{ dir: path.join(os.homedir(), ".pi", "skills"), format: "recursive" },
		{ dir: path.join(process.cwd(), ".pi", "skills"), format: "recursive" },
	];

	for (const { dir, format } of skillDirs) {
		scanSkillDir(dir, format, skillsByName);
	}

	// Sort alphabetically by name
	return Array.from(skillsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parse frontmatter from skill file
 */
function parseFrontmatter(content: string, fallbackName: string): { name: string; description: string } {
	if (!content.startsWith("---")) {
		return { name: fallbackName, description: "" };
	}

	const endIndex = content.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { name: fallbackName, description: "" };
	}

	const frontmatter = content.slice(4, endIndex);
	let name = fallbackName;
	let description = "";

	for (const line of frontmatter.split("\n")) {
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) continue;

		const key = line.slice(0, colonIndex).trim();
		const value = line.slice(colonIndex + 1).trim();

		if (key === "name") name = value;
		if (key === "description") description = value;
	}

	return { name, description };
}

/**
 * Get skill content without frontmatter
 */
function getSkillContent(skill: Skill): string {
	const raw = fs.readFileSync(skill.filePath, "utf-8");
	if (!raw.startsWith("---")) return raw;

	const endIndex = raw.indexOf("\n---", 3);
	if (endIndex === -1) return raw;

	return raw.slice(endIndex + 4).trim();
}

/**
 * Simple fuzzy match scoring
 */
function fuzzyScore(query: string, text: string): number {
	const lowerQuery = query.toLowerCase();
	const lowerText = text.toLowerCase();

	if (lowerText.includes(lowerQuery)) {
		return 100 + (lowerQuery.length / lowerText.length) * 50;
	}

	let score = 0;
	let queryIndex = 0;
	let consecutiveBonus = 0;

	for (let i = 0; i < lowerText.length && queryIndex < lowerQuery.length; i++) {
		if (lowerText[i] === lowerQuery[queryIndex]) {
			score += 10 + consecutiveBonus;
			consecutiveBonus += 5;
			queryIndex++;
		} else {
			consecutiveBonus = 0;
		}
	}

	return queryIndex === lowerQuery.length ? score : 0;
}

/**
 * Filter and sort skills by fuzzy match
 */
function filterSkills(skills: Skill[], query: string): Skill[] {
	if (!query.trim()) return skills;

	const scored = skills
		.map((skill) => ({
			skill,
			score: Math.max(
				fuzzyScore(query, skill.name),
				fuzzyScore(query, skill.description) * 0.8
			),
		}))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score);

	return scored.map((item) => item.skill);
}

/**
 * Skill Palette Overlay Component
 */
class SkillPaletteComponent {
	private allSkills: Skill[];
	private filtered: Skill[];
	private selected = 0;
	private query = "";
	private selectedSkillNames: Set<string>;
	private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
	private static readonly INACTIVITY_MS = 60000; // Auto-dismiss after 60s of no input

	constructor(
		skills: Skill[],
		queuedSkills: Skill[],
		private done: (skills: Skill[] | null, action: "apply" | "cancel") => void
	) {
		this.allSkills = skills;
		this.filtered = skills;
		this.selectedSkillNames = new Set(queuedSkills.map((skill) => skill.name));
		this.resetInactivityTimeout();
	}

	private resetInactivityTimeout(): void {
		if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
		this.inactivityTimeout = setTimeout(() => {
			this.cleanup();
			this.done(null, "cancel");
		}, SkillPaletteComponent.INACTIVITY_MS);
	}

	handleInput(data: string): void {
		this.resetInactivityTimeout(); // Reset on any input

		if (matchesKey(data, "escape")) {
			this.cleanup();
			this.done(null, "cancel");
			return;
		}

		if (matchesKey(data, "return")) {
			this.cleanup();
			const skillsByName = new Map(this.allSkills.map((skill) => [skill.name, skill]));
			this.done(
				Array.from(this.selectedSkillNames)
					.map((name) => skillsByName.get(name))
					.filter((skill): skill is Skill => skill !== undefined),
				"apply"
			);
			return;
		}

		if (matchesKey(data, "tab")) {
			this.toggleSelectedSkill();
			return;
		}

		if (matchesKey(data, "up")) {
			if (this.filtered.length > 0) {
				this.selected = this.selected === 0 ? this.filtered.length - 1 : this.selected - 1;
			}
			return;
		}

		if (matchesKey(data, "down")) {
			if (this.filtered.length > 0) {
				this.selected = this.selected === this.filtered.length - 1 ? 0 : this.selected + 1;
			}
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.query.length > 0) {
				this.query = this.query.slice(0, -1);
				this.updateFilter();
			}
			return;
		}

		// Printable character
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query += data;
			this.updateFilter();
		}
	}

	private updateFilter(): void {
		this.filtered = filterSkills(this.allSkills, this.query);
		this.selected = 0; // Always jump to top match when typing
	}

	private toggleSelectedSkill(): void {
		const skill = this.filtered[this.selected];
		if (!skill) return;

		if (this.selectedSkillNames.has(skill.name)) {
			this.selectedSkillNames.delete(skill.name);
		} else {
			this.selectedSkillNames.add(skill.name);
		}
	}

	render(width: number): string[] {
		const innerW = width - 2;
		const lines: string[] = [];

		// Theme-aware color helpers
		const t = paletteTheme;
		const border = (s: string) => fg(t.border, s);
		const title = (s: string) => fg(t.title, s);
		const selected = (s: string) => fg(t.selected, s);
		const selectedText = (s: string) => fg(t.selectedText, s);
		const queued = (s: string) => fg(t.queued, s);
		const searchIcon = (s: string) => fg(t.searchIcon, s);
		const placeholder = (s: string) => fg(t.placeholder, s);
		const description = (s: string) => fg(t.description, s);
		const hint = (s: string) => fg(t.hint, s);
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
		const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;

		const visLen = visibleWidth;

		const row = (content: string) => border("│") + truncateToWidth(" " + content, innerW, "…", true) + border("│");
		const emptyRow = () => border("│") + " ".repeat(innerW) + border("│");

		// Top border with title
		const titleText = " Skills ";
		const borderLen = innerW - visLen(titleText);
		const leftBorder = Math.floor(borderLen / 2);
		const rightBorder = borderLen - leftBorder;
		lines.push(border("╭" + "─".repeat(leftBorder)) + title(titleText) + border("─".repeat(rightBorder) + "╮"));

		lines.push(emptyRow());

		// Search input - clean underlined style
		const cursor = selected("│");
		const searchIconChar = searchIcon("◎");
		const queryDisplay = this.query
			? `${this.query}${cursor}`
			: `${cursor}${placeholder(italic("type to filter..."))}`;
		lines.push(row(`${searchIconChar}  ${queryDisplay}`));

		lines.push(emptyRow());

		// Divider
		lines.push(border("├" + "─".repeat(innerW) + "┤"));

		// Skills list
		const maxVisible = 8;
		const startIndex = Math.max(0, Math.min(this.selected - Math.floor(maxVisible / 2), this.filtered.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, this.filtered.length);

		if (this.filtered.length === 0) {
			lines.push(emptyRow());
			lines.push(row(hint(italic("No matching skills"))));
			lines.push(emptyRow());
		} else {
			lines.push(emptyRow());
			for (let i = startIndex; i < endIndex; i++) {
				const skill = this.filtered[i];
				const isSelected = i === this.selected;
				const isQueued = this.selectedSkillNames.has(skill.name);
				
				// Build the skill line
				const prefix = isSelected ? selected("▸") : border("·");
				const queuedBadge = isQueued ? ` ${queued("●")}` : "";
				const nameStr = isSelected ? bold(selectedText(skill.name)) : skill.name;
				const maxDescLen = Math.max(0, innerW - visLen(skill.name) - 12);
				const descStr = maxDescLen > 3 ? description(truncateToWidth(skill.description, maxDescLen, "…")) : "";
				
				const separator = descStr ? `  ${border("—")}  ` : "";
				const skillLine = `${prefix} ${nameStr}${queuedBadge}${separator}${descStr}`;
				lines.push(row(skillLine));
			}
			lines.push(emptyRow());

			// Scroll position indicator - rainbow dots
			if (this.filtered.length > maxVisible) {
				const prog = Math.round(((this.selected + 1) / this.filtered.length) * 10);
				const progressBar = rainbowProgress(prog, 10);
				const countStr = `${this.selected + 1}/${this.filtered.length}`;
				lines.push(row(`${progressBar}  ${hint(countStr)}`));
				lines.push(emptyRow());
			}
		}

		// Divider
		lines.push(border("├" + "─".repeat(innerW) + "┤"));

		lines.push(emptyRow());

		// Footer hints - minimal and elegant
		const selectedCount = this.selectedSkillNames.size;
		const hints = `${italic("↑↓")} navigate  ${italic("tab")} toggle  ${italic("enter")} apply (${selectedCount})  ${italic("esc")} cancel`;
		lines.push(row(hint(hints)));

		// Bottom border
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	private cleanup(): void {
		if (this.inactivityTimeout) {
			clearTimeout(this.inactivityTimeout);
			this.inactivityTimeout = null;
		}
	}

	invalidate(): void {}
	
	dispose(): void {
		this.cleanup();
	}
}

export default function skillPaletteExtension(pi: ExtensionAPI): void {
	// Register custom renderer for skill-context messages
	pi.registerMessageRenderer("skill-context", (message, options, theme) => {
		// Extract skill names and content (handle both string and array content)
		const rawContent = typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content.map((c: { type: string; text?: string }) => c.type === "text" ? c.text || "" : "").join("")
				: "";
		const skillBlocks = Array.from(rawContent.matchAll(/<skill name="([^"]+)">\n?([\s\S]*?)\n?<\/skill>/g));
		const skillNames = skillBlocks.map((match) => match[1]);
		const previewContent = skillBlocks.length > 0
			? skillBlocks.map((match) => match[2].trim()).join("\n\n")
			: rawContent;
		const title = skillNames.length > 1
			? `Skills (${skillNames.length}): ${skillNames.join(", ")}`
			: `Skill: ${skillNames[0] || "Unknown Skill"}`;
		
		const container = new Container();
		
		// Header with skill name(s) (like read tool)
		const header = new Text(
			theme.fg("customMessageLabel", theme.bold(title)),
			1, 0
		);
		container.addChild(header);
		
		// Content preview (collapsible like read tool)
		const lines = previewContent.split("\n");
		const PREVIEW_LINES = 8;
		const isLong = lines.length > PREVIEW_LINES;
		const showLines = options.expanded ? lines : lines.slice(0, PREVIEW_LINES);
		
		// Add content lines with dim styling
		for (const line of showLines) {
			container.addChild(new Text(theme.fg("dim", line), 1, 0));
		}
		
		// Show truncation indicator if collapsed and content is long
		if (!options.expanded && isLong) {
			const hiddenCount = lines.length - PREVIEW_LINES;
			container.addChild(new Text(
				theme.fg("muted", `... ${hiddenCount} more lines (click to expand)`),
				1, 0
			));
		}
		
		return container;
	});

	// Register the /skill command
	pi.registerCommand("skill", {
		description: "Open skill palette to select a skill for the next message",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const skills = loadSkills();

			if (skills.length === 0) {
				ctx.ui.setStatus("skill", "No skills found");
				setTimeout(() => ctx.ui.setStatus("skill", undefined), 3000);
				return;
			}

			// Show the overlay and wait for result
			const result = await ctx.ui.custom<{ skills: Skill[] | null; action: "apply" | "cancel" }>(
				(_tui, _theme, _keybindings, done) => new SkillPaletteComponent(
					skills,
					state.queuedSkills,
					(selectedSkills, action) => done({ skills: selectedSkills, action })
				),
				{ overlay: true, overlayOptions: { anchor: "center", width: 70 } }
			);

			if (result.action === "apply" && result.skills) {
				state.queuedSkills = result.skills;

				if (state.queuedSkills.length === 0) {
					ctx.ui.setStatus("skill", undefined);
					ctx.ui.setWidget("skill", undefined);
					ctx.ui.notify("Skills cleared", "info");
					return;
				}

				const names = state.queuedSkills.map((skill) => skill.name).join(", ");
				// ctx.ui.setStatus("skill", `Skills ${state.queuedSkills.length}`);
				ctx.ui.setWidget("skill", [`\x1b[2mSkills: \x1b[0m\x1b[36m${names}\x1b[0m\x1b[2m — will be applied to next message\x1b[0m`]);
				ctx.ui.notify(`Skills queued: ${names}`, "info");
			}
		},
	});

	// Handle the before_agent_start event to send skill content as custom message
	pi.on("before_agent_start", async (_event, ctx) => {
		if (state.queuedSkills.length === 0) {
			return {};
		}

		const skills = [...state.queuedSkills];
		state.queuedSkills = [];

		// Clear the visual indicators (use optional chaining for non-UI contexts)
		ctx.ui?.setStatus("skill", undefined);
		ctx.ui?.setWidget("skill", undefined);

		const skillBlocks: string[] = [];
		const failedSkills: string[] = [];

		for (const skill of skills) {
			try {
				const skillContent = getSkillContent(skill);
				skillBlocks.push(`<skill name="${skill.name}">\n${skillContent}\n</skill>`);
			} catch {
				failedSkills.push(skill.name);
			}
		}

		if (failedSkills.length > 0) {
			ctx.ui?.notify(`Failed to load skill${failedSkills.length > 1 ? "s" : ""}: ${failedSkills.join(", ")}`, "warning");
		}

		if (skillBlocks.length === 0) {
			return {};
		}

		return {
			message: {
				customType: "skill-context",
				content: skillBlocks.join("\n\n"),
				display: true,  // Show the skill injection in chat
			},
		};
	});
}
