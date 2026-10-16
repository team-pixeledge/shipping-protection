// Is the app embed switched on in the live theme? Read from the main
// theme's config/settings_data.json (needs read_themes). The embed's block
// type looks like shopify://apps/<app>/blocks/shipping-protection-embed/<uid>.
import type { AdminGraphql } from "./setup.server";

export const EMBED_HANDLE = "shipping-protection-embed";

export type EmbedStatus = "on" | "off" | "unknown";

/** settings_data.json may open with a /* … *\/ comment block. */
export function parseSettingsData(content: string): unknown {
  return JSON.parse(content.replace(/^\s*\/\*[\s\S]*?\*\//, ""));
}

export function embedEnabled(settingsData: unknown): boolean {
  const blocks = (settingsData as { current?: { blocks?: Record<string, { type?: string; disabled?: boolean }> } })
    ?.current?.blocks;
  if (!blocks || typeof blocks !== "object") return false;
  return Object.values(blocks).some(
    (b) => typeof b?.type === "string" && b.type.includes(`/blocks/${EMBED_HANDLE}/`) && b.disabled !== true,
  );
}

export async function embedStatus(admin: AdminGraphql): Promise<{ status: EmbedStatus; themeName?: string }> {
  try {
    const res = await admin.graphql(`#graphql
      query SpMainTheme {
        themes(first: 1, roles: [MAIN]) {
          nodes {
            name
            files(filenames: ["config/settings_data.json"], first: 1) {
              nodes { body { ... on OnlineStoreThemeFileBodyText { content } } }
            }
          }
        }
      }`);
    const json = (await res.json()) as {
      data?: { themes: { nodes: { name: string; files: { nodes: { body: { content?: string } }[] } }[] } };
    };
    const theme = json.data?.themes.nodes[0];
    const content = theme?.files.nodes[0]?.body.content;
    if (!theme || !content) return { status: "unknown" };
    return { status: embedEnabled(parseSettingsData(content)) ? "on" : "off", themeName: theme.name };
  } catch (err) {
    console.warn("[embed] status check failed:", err instanceof Error ? err.message : err);
    return { status: "unknown" };
  }
}
