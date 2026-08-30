import type { DefaultTheme } from "vitepress";

export const enSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: "Guide",
    items: [
      { text: "Guide overview", link: "/en/guide/" },
      { text: "Installation", link: "/en/guide/installation" },
      { text: "Configuration", link: "/en/guide/configuration" },
      { text: "Web UI", link: "/en/guide/webui" },
    ],
  },
  {
    text: "Development",
    items: [
      { text: "Development overview", link: "/en/developers/" },
      { text: "Documentation style", link: "/en/developers/markdown-features" },
    ],
  },
  {
    text: "Reference",
    items: [{ text: "Reference index", link: "/en/reference/" }],
  },
  {
    text: "Project",
    items: [{ text: "Roadmap and status", link: "/en/project/" }],
  },
];
