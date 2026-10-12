import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { SettingsField, SettingsSection } from "@paulsteele/pi-shared-ui";
import { fileSettingsDraft } from "@paulsteele/pi-shared-ui/storage";

function fieldGroup(path: string): string | undefined {
	const isCredentialField = path.endsWith("ApiKey") || path.endsWith("ApiToken");
	const isBrowserAccessField = path.endsWith("Headers") || path === "browserCookies" || path === "authFetch";
	if (isCredentialField || isBrowserAccessField) {
		return "Credentials & Browser Access";
	}
	const isEndpointField = path.endsWith("BaseUrl");
	const isNetworkPolicyField = ["proxy", "ssrf", "fetchContent"].includes(path);
	const isGeminiConnectionField = ["geminiAuth", "geminiProject", "geminiLocation"].includes(path);
	if (isEndpointField || isNetworkPolicyField || isGeminiConnectionField) {
		return "Endpoints & Network";
	}
	const isExtractionField =
		path.startsWith("github") || ["youtube", "video", "pdf", "image", "fetch"].includes(path);
	if (isExtractionField) {
		return "Extraction";
	}
	const isSummaryOrCuratorField =
		path.startsWith("summary") || path.startsWith("curator") || path === "autoOpenBrowser";
	if (isSummaryOrCuratorField) {
		return "Summary & Curator";
	}
	return undefined;
}

function booleanField(path: string, label: string): SettingsField {
	const group = fieldGroup(path);
	return { path, label, kind: "boolean", ...(group ? { group } : {}) };
}

function jsonField(path: string, label: string, secret = false): SettingsField {
	const group = fieldGroup(path);
	return { path, label, kind: "json", secret, ...(group ? { group } : {}) };
}

function stringField(path: string, label: string, choices?: string[]): SettingsField {
	const group = fieldGroup(path);
	return { path, label, kind: "string", ...(choices ? { choices } : {}), ...(group ? { group } : {}) };
}

function numberField(path: string, label: string): SettingsField {
	const group = fieldGroup(path);
	return { path, label, kind: "number", ...(group ? { group } : {}) };
}

function configuredField(value: Record<string, unknown>, path: string): unknown {
	let current: unknown = value;
	for (const key of path.split(".")) {
		if (!current || typeof current !== "object" || Array.isArray(current)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function validateFields(value: Record<string, unknown>, fields: SettingsField[]): void {
	for (const field of fields) {
		const current = configuredField(value, field.path);
		if (current === undefined || current === null || field.kind === "json") {
			continue;
		}
		const expectedType = field.kind === "model" ? "string" : field.kind;
		if (typeof current !== expectedType || (field.choices && !field.choices.includes(String(current)))) {
			throw new Error(`Invalid setting: ${field.label}`);
		}
		if (field.kind === "number" && (!Number.isFinite(current) || Number(current) < 0)) {
			throw new Error(`Expected a non-negative finite value: ${field.label}`);
		}
	}
}

function fileSection(options: {
	plugin?: SettingsSection["plugin"];
	id: string;
	title: string;
	path: string;
	fields: SettingsField[];
	description: string;
}): SettingsSection {
	return {
		...(options.plugin ? { plugin: options.plugin } : {}),
		id: options.id,
		title: options.title,
		fields: options.fields,
		description: options.description,
		effect:
			"Saved. Reload Pi to adopt all changes; existing viewers and tool calls retain their current configuration.",
		load: () => fileSettingsDraft(options.path, (value) => validateFields(value, options.fields)),
	};
}

function webConfigPath(): string {
	if (process.env.PI_CODING_AGENT_DIR) {
		return join(process.env.PI_CODING_AGENT_DIR, "web-search.json");
	}
	const xdg = process.env.XDG_CONFIG_HOME;
	const legacy = join(homedir(), ".pi", "web-search.json");
	const current = xdg ? join(xdg, "pi", "web-search.json") : join(getAgentDir(), "web-search.json");
	if (existsSync(current)) {
		return current;
	}
	return existsSync(legacy) ? legacy : current;
}

function questionnaireConfigPath(): string {
	const legacy = join(homedir(), ".config", "rpiv-ask-user-question", "config.json");
	const configuredXdg = process.env.XDG_CONFIG_HOME?.replace(/^~(?=\/)/, homedir());
	const xdg = configuredXdg && isAbsolute(configuredXdg) ? configuredXdg : join(homedir(), ".config");
	const current = join(xdg, "rpiv-ask-user-question", "config.json");
	return existsSync(current) || !existsSync(legacy) ? current : legacy;
}

function webSettings(): SettingsSection {
	return fileSection({
		id: "web",
		title: "Web Access",
		path: webConfigPath(),
		description: "Search, extraction, privacy, and curator configuration",
		fields: [
			stringField("provider", "Default search provider"),
			stringField("workflow", "Search workflow", ["none", "summary-review", "auto-summary"]),
			stringField("toolActivation", "Tool activation", ["auto", "dynamic", "eager"]),
			jsonField("tools", "Enabled tools"),
			jsonField("commands", "Enabled commands"),
			jsonField("webSearch", "Search enablement and provider allowlist"),
			jsonField("searchRouting", "Search routes and fallbacks"),
			jsonField("fetchRouting", "Fetch routes and hosted providers"),
			stringField("summaryModel", "Summary model"),
			stringField("summaryInstructions", "Summary instructions"),
			numberField("summaryGenerationDeadlineMs", "Summary deadline (ms)"),
			numberField("maxInlineContentChars", "Inline content characters"),
			jsonField("fetch", "Fetch timeout, modes, and answer model"),
			jsonField("githubClone", "GitHub cloning"),
			jsonField("githubPrIssue", "GitHub PR/issue extraction"),
			jsonField("youtube", "YouTube extraction"),
			jsonField("video", "Local video extraction"),
			jsonField("pdf", "PDF extraction"),
			jsonField("image", "Images"),
			stringField("proxy", "Web proxy URL"),
			jsonField("ssrf", "SSRF exceptions and proxy trust"),
			jsonField("fetchContent", "Fetch domain policy"),
			booleanField("allowBrowserCookies", "Allow host browser cookies"),
			jsonField("browserCookies", "Browser/profile selection"),
			jsonField("authFetch", "Authenticated fetch profiles", true),
			jsonField("curatorRemote", "Remote curator binding"),
			booleanField("autoOpenBrowser", "Open curator browser"),
			numberField("curatorTimeoutSeconds", "Curator timeout (seconds)"),
			jsonField("shortcuts", "Keyboard shortcuts"),
			jsonField("openaiSearchProviders", "Pi credential providers"),
			booleanField("openaiUseProviderBaseUrl", "Reuse Pi provider URL"),
			booleanField("openaiUseAlphaSearch", "OpenAI standalone search"),
			stringField("openaiResponsesUrl", "Responses endpoint"),
			stringField("openaiSearchModel", "OpenAI search model"),
			stringField("searchModel", "Gemini search model"),
			stringField("searxngBaseUrl", "SearXNG endpoint"),
			jsonField("searxngHeaders", "SearXNG headers", true),
			stringField("firecrawlBaseUrl", "Firecrawl endpoint"),
			booleanField("firecrawlFreshScrape", "Allow Firecrawl fresh scraping"),
			stringField("crawl4aiBaseUrl", "Crawl4AI endpoint"),
			...searchApiKeyFields(),
			{
				path: "crawl4aiApiToken",
				label: "Crawl4AI credential source",
				kind: "string",
				group: "Credentials & Browser Access",
				secret: true,
			},
			stringField("geminiAuth", "Gemini authentication", ["api-key", "adc"]),
			stringField("geminiProject", "Vertex project"),
			stringField("geminiLocation", "Vertex location"),
			stringField("geminiBaseUrl", "Gemini endpoint"),
			stringField("braveBaseUrl", "Brave endpoint"),
			stringField("exaBaseUrl", "Exa endpoint"),
			stringField("tavilyBaseUrl", "Tavily endpoint"),
			stringField("degoogBaseUrl", "degoog endpoint"),
			jsonField("degoogEngines", "degoog engine selection"),
			stringField("brightdataSerpZone", "Bright Data SERP zone"),
			stringField("brightdataUnlockerZone", "Bright Data Unlocker zone"),
			stringField("mistralSearchModel", "Mistral search model"),
			stringField("mistralSearchTool", "Mistral search tool", ["web_search", "web_search_premium"]),
			jsonField("xaiSearchTools", "xAI search tools"),
		],
	});
}

const SEARCH_API_KEY_PROVIDERS = [
	"openai",
	"brave",
	"exa",
	"parallel",
	"tinyfish",
	"search1api",
	"searchinfinity",
	"querit",
	"tavily",
	"you",
	"jina",
	"serpdive",
	"kagi",
	"bocha",
	"ollama",
	"valyu",
	"serpbase",
	"serpapi",
	"serper",
	"serply",
	"baizhi",
	"zai",
	"keenable",
	"degoog",
	"anysearch",
	"xcrawl",
	"xai",
	"mistral",
	"brightdata",
	"firecrawl",
	"perplexity",
	"gemini",
	"datalab",
	"cloudflare",
] as const;

function searchApiKeyFields(): SettingsField[] {
	return SEARCH_API_KEY_PROVIDERS.map(
		(provider): SettingsField => ({
			path: `${provider}ApiKey`,
			label: `${provider} credential source`,
			kind: "string",
			group: "Credentials & Browser Access",
			secret: true,
		}),
	);
}

function plannotatorSettings(): SettingsSection[] {
	const dataDir = process.env.PLANNOTATOR_DATA_DIR ?? join(homedir(), ".plannotator");
	return [
		fileSection({
			plugin: {
				id: "plannotator",
				title: "Plannotator",
				description: "Viewer appearance, privacy, and phase profiles",
			},
			id: "plannotator",
			title: "Viewer Settings",
			path: join(dataDir, "config.json"),
			description: "Viewer appearance, history, privacy, and agent integrations",
			fields: [
				booleanField("agentTool", "Expose agent tool"),
				booleanField("jina", "Jina URL extraction"),
				booleanField("pfmReminder", "Planning reminder"),
				booleanField("annotateHistory", "Annotation history"),
				booleanField("feedbackHistory", "Feedback archive"),
				booleanField("guideHistory", "Guide history"),
				booleanField("reviewProgress", "Remember viewed files"),
				booleanField("glimpse", "Prefer Glimpse browser"),
				stringField("share", "Sharing", ["enabled", "disabled"]),
				stringField("agentTerminalSide", "Agent terminal placement", ["left", "right", "hidden"]),
				stringField("agentTerminalDefaultAgent", "Default terminal agent"),
				jsonField("theme", "Viewer theme"),
				jsonField("diffOptions", "Diff display options"),
				jsonField("reviewAnalysis", "Review analysis layers"),
				booleanField("conventionalComments", "Conventional comments"),
				jsonField("conventionalLabels", "Comment labels"),
				jsonField("markdownExtensions", "Extra markdown extensions"),
				jsonField("prompts", "Prompt overrides"),
				stringField("displayName", "Display name"),
				stringField("guideShareUrl", "Guide sharing endpoint"),
				stringField("bitbucketEmail", "Bitbucket account email"),
				{ path: "bitbucketToken", label: "Bitbucket token", kind: "string", secret: true },
			],
		}),
		fileSection({
			plugin: {
				id: "plannotator",
				title: "Plannotator",
				description: "Viewer appearance, privacy, and phase profiles",
			},
			id: "plannotator-phases",
			title: "Plannotator Phases",
			path: join(getAgentDir(), "plannotator.json"),
			description:
				"Global phase profiles; trusted .pi/plannotator.json project overrides still take precedence",
			fields: [
				stringField("executionMode", "Execution mode", ["automatic", "external"]),
				jsonField("defaults", "Default model/tools/instructions"),
				jsonField("phases", "Planning, execution, and review overrides"),
			],
		}),
	];
}

export function thirdPartySettings(pi: Pick<ExtensionAPI, "getAllTools">): SettingsSection[] {
	const tools = pi.getAllTools();
	const packageLoaded = (source: string) =>
		tools.some(
			(tool) =>
				tool.sourceInfo.origin === "package" &&
				(tool.sourceInfo.source === source || tool.sourceInfo.source.startsWith(`${source}@`)),
		);
	const sections: SettingsSection[] = [];
	if (packageLoaded("npm:pi-web-access")) {
		sections.push(webSettings());
	}
	if (packageLoaded("npm:@plannotator/pi-extension")) {
		sections.push(...plannotatorSettings());
	}
	if (packageLoaded("npm:@juicesharp/rpiv-ask-user-question")) {
		sections.push(
			fileSection({
				id: "questionnaire",
				title: "Questionnaire",
				path: questionnaireConfigPath(),
				description: "Collapse shortcut and model-facing guidance",
				fields: [
					stringField("collapseKey", "Collapse shortcut"),
					stringField("guidance.description", "Tool description"),
					stringField("guidance.promptSnippet", "Prompt snippet"),
					jsonField("guidance.promptGuidelines", "Prompt guidelines"),
				],
			}),
		);
	}
	return sections;
}
